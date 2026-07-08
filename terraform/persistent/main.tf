# 永続層（persistent）: 検証サイクルで destroy しないリソース群
# 設計判断は ADR 0009 を参照。
#
# - Route53 ホストゾーン（idp-golden-path.click）
# - ACM 証明書（DNS 検証）
# - ECR リポジトリ（Backstage イメージ）
# - TechDocs 用 S3 バケット
# - Backstage backend secret（Secrets Manager、apply 毎の再生成を避ける）
# - GitHub OAuth シークレットの参照（値は扱わない）
# - GitHub OIDC ロール + permissions boundary
# - AWS Budgets（月 $5 アラート）

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  backend "s3" {
    bucket       = "idp-golden-path-tfstate-ba25cd9e"
    key          = "persistent/terraform.tfstate"
    region       = "ap-northeast-1"
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "idp-golden-path"
      ManagedBy = "terraform"
      Layer     = "persistent"
    }
  }
}

data "aws_caller_identity" "current" {}

# --- Route53 ホストゾーン ---------------------------------------------------
# ドメイン登録（Route53 Domains）時に自動作成されたゾーンを import して管理する。
# レジストラの NS 設定は自動作成ゾーンと一致しているため、Terraform では触らない。

resource "aws_route53_zone" "main" {
  name    = var.domain_name
  comment = "idp-golden-path production domain (ADR 0009)"
}

# --- ACM 証明書（ALB 用、DNS 検証） -----------------------------------------

resource "aws_acm_certificate" "main" {
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# 証明書は apex 単一ドメイン（SAN なし）のため検証レコードは常に 1 件。
# for_each を unknown 値（domain_validation_options）に依存させると
# ゾーンの terraform import 時の plan 評価が失敗するため、静的な単一リソースとする。
resource "aws_route53_record" "cert_validation" {
  zone_id         = aws_route53_zone.main.zone_id
  name            = tolist(aws_acm_certificate.main.domain_validation_options)[0].resource_record_name
  type            = tolist(aws_acm_certificate.main.domain_validation_options)[0].resource_record_type
  ttl             = 300
  records         = [tolist(aws_acm_certificate.main.domain_validation_options)[0].resource_record_value]
  allow_overwrite = true

  lifecycle {
    # SAN を追加する場合はこの静的単一レコードの前提が崩れるため明示的に失敗させる
    precondition {
      condition     = length(aws_acm_certificate.main.domain_validation_options) == 1
      error_message = "証明書の検証レコードが複数必要です。cert_validation を複数レコード対応に変更してください。"
    }
  }
}

resource "aws_acm_certificate_validation" "main" {
  certificate_arn         = aws_acm_certificate.main.arn
  validation_record_fqdns = [aws_route53_record.cert_validation.fqdn]
}

# --- ECR リポジトリ ----------------------------------------------------------

resource "aws_ecr_repository" "backstage" {
  name                 = "idp-golden-path-backstage"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "backstage" {
  repository = aws_ecr_repository.backstage.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "直近 5 イメージのみ保持（検証毎に push するため古いものは不要）"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 5
        }
        action = { type = "expire" }
      }
    ]
  })
}

# --- TechDocs 用 S3 バケット --------------------------------------------------

resource "aws_s3_bucket" "techdocs" {
  bucket = "idp-golden-path-techdocs-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "techdocs" {
  bucket                  = aws_s3_bucket.techdocs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "techdocs" {
  bucket = aws_s3_bucket.techdocs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# --- Secrets Manager ----------------------------------------------------------
# GitHub OAuth App の Client ID / Secret は事前に手動登録済み（値は Terraform で扱わない）
data "aws_secretsmanager_secret" "github_oauth" {
  name = "idp-golden-path/github-oauth"
}

# Backstage backend secret / session 鍵。
# 永続層で一度だけ生成し、ephemeral 層の apply 毎にセッションが無効化されるのを避ける（ADR 0009）。
resource "random_password" "backend_secret" {
  length  = 48
  special = false
}

resource "random_password" "session_secret" {
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret" "backstage_backend" {
  name        = "idp-golden-path/backstage-backend"
  description = "Backstage backend-to-backend auth secret and session key (ADR 0009)"

  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "backstage_backend" {
  secret_id = aws_secretsmanager_secret.backstage_backend.id
  secret_string = jsonencode({
    BACKEND_SECRET      = random_password.backend_secret.result
    AUTH_SESSION_SECRET = random_password.session_secret.result
  })
}

# --- GitHub OIDC ロール + permissions boundary ---------------------------------
# CI 駆動 deploy / destroy 用（ADR 0010）。アカウント共通の OIDC provider を参照する。
# イメージ push / TechDocs publish に加えて、ephemeral / shared 層の
# terraform apply / destroy に必要な権限を持つ。persistent 層の tfstate には書き込めない。

data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

locals {
  # bootstrap 時に手動作成した state バケット（runbook 参照）
  tfstate_bucket_arn = "arn:aws:s3:::idp-golden-path-tfstate-ba25cd9e"
}

data "aws_iam_policy_document" "github_actions_boundary" {
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "EcrPush"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage",
    ]
    resources = [aws_ecr_repository.backstage.arn]
  }

  statement {
    sid = "TechdocsPublish"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:ListBucket",
    ]
    resources = [
      aws_s3_bucket.techdocs.arn,
      "${aws_s3_bucket.techdocs.arn}/*",
    ]
  }

  # ---- 以下、ephemeral / shared 層の terraform apply / destroy 用（ADR 0010） ----

  # tfstate の読み取りは全層（ephemeral の remote_state が persistent を参照するため）。
  # 書き込みは ephemeral / shared のみに限定し、CI から persistent 層の state を壊せないようにする。
  #
  # 既知の受容リスク: terraform_remote_state は outputs だけでなく state ファイル全体を
  # 取得するため、persistent state 内の random_password 生成値（backend secret / session 鍵）も
  # CI ロールから読める。トリガーが workflow_dispatch のみ・実行されるのは main の workflow 定義・
  # リポジトリ書き込み権限者が本人のみであることから受容する（ADR 0010）。
  statement {
    sid = "TfstateRead"
    actions = [
      "s3:ListBucket",
      "s3:GetObject",
    ]
    resources = [
      local.tfstate_bucket_arn,
      "${local.tfstate_bucket_arn}/*",
    ]
  }

  statement {
    sid = "TfstateWriteEphemeralShared"
    actions = [
      "s3:PutObject",
      "s3:DeleteObject",
    ]
    resources = [
      "${local.tfstate_bucket_arn}/ephemeral/*",
      "${local.tfstate_bucket_arn}/shared/*",
    ]
  }

  # VPC / IPAM（ec2）、ECS、ALB、Aurora、CloudWatch Logs。
  # これらはリソース単位の制限が実用的でないため、リージョン条件で境界を引く。
  #
  # - ec2 をタグ条件で絞らないのは、Describe 系・IPAM 系など多くの API が
  #   リソースタグ条件を評価できず、apply が壊れやすいため（同一リージョンの
  #   他プロジェクト VPC に届き得る点は既知の受容リスクとして ADR 0010 に記録）
  # - logs は ephemeral 層が /ecs/idp-golden-path/* しか扱わないが、
  #   DescribeLogGroups が "*" を要求するためまとめてリージョン境界で受容する
  statement {
    sid = "TerraformRegionalInfra"
    actions = [
      "ec2:*",
      "ecs:*",
      "elasticloadbalancing:*",
      "rds:*",
      "logs:*",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.region]
    }
  }

  # ephemeral 層のタスクロール / タスク実行ロールの管理。
  # 名前を idp-golden-path-* に限定する。managed policy の attach は
  # ECS タスク実行用の AWS 管理ポリシーのみに絞り、権限昇格経路を塞ぐ。
  statement {
    sid = "TaskRoleManagement"
    actions = [
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:GetRole",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:GetRolePolicy",
      "iam:ListRolePolicies",
      "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole",
    ]
    resources = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/idp-golden-path-*"]
  }

  statement {
    sid = "TaskRoleAttachEcsExecutionPolicyOnly"
    actions = [
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
    ]
    resources = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/idp-golden-path-*"]

    condition {
      test     = "ArnEquals"
      variable = "iam:PolicyARN"
      values   = ["arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"]
    }
  }

  statement {
    sid       = "TaskRolePass"
    actions   = ["iam:PassRole"]
    resources = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/idp-golden-path-*"]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  # 初回 apply 時に必要になり得る service-linked role（既存なら no-op）
  statement {
    sid       = "ServiceLinkedRoles"
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "iam:AWSServiceName"
      values = [
        "ecs.amazonaws.com",
        "elasticloadbalancing.amazonaws.com",
        "rds.amazonaws.com",
        "ipam.amazonaws.com",
      ]
    }
  }

  # ephemeral 層の ALB alias レコード操作（対象ゾーン限定）
  statement {
    sid = "Route53Records"
    actions = [
      "route53:ChangeResourceRecordSets",
      "route53:ListResourceRecordSets",
      "route53:GetHostedZone",
    ]
    resources = [aws_route53_zone.main.arn]
  }

  statement {
    sid       = "Route53GetChange"
    actions   = ["route53:GetChange"]
    resources = ["arn:aws:route53:::change/*"]
  }
}

resource "aws_iam_policy" "github_actions_boundary" {
  name        = "idp-golden-path-github-actions-boundary"
  description = "Permissions boundary for idp-golden-path GitHub Actions role"
  policy      = data.aws_iam_policy_document.github_actions_boundary.json
}

data "aws_iam_policy_document" "github_actions_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:kmryst/idp-golden-path:*"]
    }
  }
}

resource "aws_iam_role" "github_actions" {
  name                 = "idp-golden-path-github-actions"
  assume_role_policy   = data.aws_iam_policy_document.github_actions_trust.json
  permissions_boundary = aws_iam_policy.github_actions_boundary.arn
}

resource "aws_iam_role_policy" "github_actions" {
  name   = "idp-golden-path-github-actions"
  role   = aws_iam_role.github_actions.id
  policy = data.aws_iam_policy_document.github_actions_boundary.json
}

# --- AWS Budgets（月 $5） -------------------------------------------------------
# Project タグでのフィルタにはコスト配分タグの有効化が必要（ADR 0009 の既知の制約）。

resource "aws_budgets_budget" "monthly" {
  name         = "idp-golden-path-monthly"
  budget_type  = "COST"
  limit_amount = "5"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "TagKeyValue"
    values = ["user:Project$idp-golden-path"]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.budget_alert_email]
  }
}
