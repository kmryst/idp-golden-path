# Aurora Serverless v2（PostgreSQL 互換）
# 選定は学習テーマ主導（ADR 0009 に明記）。検証毎に破棄する前提のため
# skip_final_snapshot = true / deletion_protection = false とする。

resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_rds_cluster" "main" {
  cluster_identifier = local.name
  engine             = "aurora-postgresql"
  engine_mode        = "provisioned"
  engine_version     = var.aurora_engine_version

  database_name               = "backstage"
  master_username             = "backstage"
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]

  serverlessv2_scaling_configuration {
    # min 0 ACU（auto-pause）。Backstage 稼働中は knex がコネクションを保持するため
    # ほぼ発動しない点は ADR 0009 に明記済み。
    min_capacity             = 0
    max_capacity             = 2
    seconds_until_auto_pause = 300
  }

  storage_encrypted   = true
  skip_final_snapshot = true
  deletion_protection = false
  apply_immediately   = true
}

resource "aws_rds_cluster_instance" "writer" {
  identifier         = "${local.name}-writer"
  cluster_identifier = aws_rds_cluster.main.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.main.engine
  engine_version     = aws_rds_cluster.main.engine_version
}
