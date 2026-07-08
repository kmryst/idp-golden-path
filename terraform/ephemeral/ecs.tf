# ECS Fargate（素の ECS。タスク定義・SG・IAM を明示的に管理する。ADR 0009）

resource "aws_ecs_cluster" "main" {
  name = local.name
}

resource "aws_cloudwatch_log_group" "backstage" {
  name              = "/ecs/${local.name}/backstage"
  retention_in_days = 7
}

# --- IAM: タスク実行ロール（イメージ pull / ログ / シークレット注入） -----------

data "aws_iam_policy_document" "ecs_tasks_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_execution" {
  name               = "${local.name}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json

  # CI ロール（GitHub Actions）の iam:CreateRole / iam:PutRolePolicy は
  # 「この boundary を付けたロール」に対してのみ許可される（persistent 層の設計。ADR 0010）
  permissions_boundary = data.terraform_remote_state.persistent.outputs.ci_permissions_boundary_arn
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "task_execution_secrets" {
  statement {
    sid     = "InjectSecrets"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      data.terraform_remote_state.persistent.outputs.github_oauth_secret_arn,
      data.terraform_remote_state.persistent.outputs.backstage_backend_secret_arn,
      aws_rds_cluster.main.master_user_secret[0].secret_arn,
    ]
  }
}

resource "aws_iam_role_policy" "task_execution_secrets" {
  name   = "${local.name}-inject-secrets"
  role   = aws_iam_role.task_execution.id
  policy = data.aws_iam_policy_document.task_execution_secrets.json
}

# --- IAM: タスクロール（TechDocs S3 読み取り） ----------------------------------

resource "aws_iam_role" "task" {
  name               = "${local.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json

  # task_execution と同様、CI からの作成を成立させるため boundary を強制する
  permissions_boundary = data.terraform_remote_state.persistent.outputs.ci_permissions_boundary_arn
}

data "aws_iam_policy_document" "task_techdocs" {
  statement {
    sid = "TechdocsRead"
    actions = [
      "s3:GetObject",
      "s3:ListBucket",
    ]
    resources = [
      data.terraform_remote_state.persistent.outputs.techdocs_bucket_arn,
      "${data.terraform_remote_state.persistent.outputs.techdocs_bucket_arn}/*",
    ]
  }
}

resource "aws_iam_role_policy" "task_techdocs" {
  name   = "${local.name}-techdocs-read"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task_techdocs.json
}

# --- タスク定義 -----------------------------------------------------------------

resource "aws_ecs_task_definition" "backstage" {
  family                   = "${local.name}-backstage"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024 # 最低 1 vCPU（ADR 0009）
  memory                   = 2048 # 最低 2 GB（ADR 0009）
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = "backstage"
      image     = "${local.ecr_url}:${var.image_tag}"
      essential = true

      portMappings = [
        {
          containerPort = 7007
          protocol      = "tcp"
        }
      ]

      environment = [
        { name = "POSTGRES_HOST", value = aws_rds_cluster.main.endpoint },
        { name = "POSTGRES_PORT", value = "5432" },
        { name = "TECHDOCS_S3_BUCKET_NAME", value = local.techdocs_bucket },
        { name = "AWS_REGION", value = var.region },
      ]

      secrets = [
        {
          name      = "POSTGRES_USER"
          valueFrom = "${aws_rds_cluster.main.master_user_secret[0].secret_arn}:username::"
        },
        {
          name      = "POSTGRES_PASSWORD"
          valueFrom = "${aws_rds_cluster.main.master_user_secret[0].secret_arn}:password::"
        },
        {
          name      = "AUTH_GITHUB_CLIENT_ID"
          valueFrom = "${data.terraform_remote_state.persistent.outputs.github_oauth_secret_arn}:clientId::"
        },
        {
          name      = "AUTH_GITHUB_CLIENT_SECRET"
          valueFrom = "${data.terraform_remote_state.persistent.outputs.github_oauth_secret_arn}:clientSecret::"
        },
        {
          name      = "BACKEND_SECRET"
          valueFrom = "${data.terraform_remote_state.persistent.outputs.backstage_backend_secret_arn}:BACKEND_SECRET::"
        },
        {
          name      = "AUTH_SESSION_SECRET"
          valueFrom = "${data.terraform_remote_state.persistent.outputs.backstage_backend_secret_arn}:AUTH_SESSION_SECRET::"
        },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.backstage.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "backstage"
        }
      }
    }
  ])
}

# --- ALB（internet-facing / public サブネット） ----------------------------------

resource "aws_lb" "main" {
  name               = local.name
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id
}

resource "aws_lb_target_group" "backstage" {
  # ECS サービスから参照中の置き換えで ResourceInUse にならないよう
  # name_prefix + create_before_destroy とする
  name_prefix = "idpgp-"
  port        = 7007
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id

  lifecycle {
    create_before_destroy = true
  }

  health_check {
    # 新 backend system の実エンドポイント（ADR 0009 参照）
    path                = "/.backstage/health/v1/readiness"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 5
  }

  deregistration_delay = 30
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = local.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.backstage.arn
  }
}

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# --- ECS サービス -----------------------------------------------------------------

resource "aws_ecs_service" "backstage" {
  name            = "backstage"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.backstage.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  # Aurora resume（〜15 秒）+ Backstage 起動を見込む（60 秒以上。ADR 0009）
  health_check_grace_period_seconds = 180

  # タスクが起動失敗を繰り返す場合にデプロイを打ち切る（コスト暴走防止）
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.backstage.arn
    container_name   = "backstage"
    container_port   = 7007
  }

  depends_on = [
    aws_lb_listener.https,
    aws_rds_cluster_instance.writer,
  ]
}

# --- Route53 alias（ALB の DNS 名は apply 毎に変わるため ephemeral 層） -------------

resource "aws_route53_record" "apex" {
  zone_id = local.zone_id
  name    = local.domain_name
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}
