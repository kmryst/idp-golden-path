# ephemeral 層: 検証時のみ apply → 動作確認 → destroy するリソース群
# 設計判断は ADR 0009 を参照。
#
# - VPC（ipam 層の IPAM プールから CIDR 払い出し）
# - ECS Fargate + ALB（ALB は public、タスクは private）
# - Aurora Serverless v2（PostgreSQL 互換）
# - Route53 の ALB 向け alias レコード（ALB の DNS 名は apply 毎に変わるためこの層に属する）

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  backend "s3" {
    bucket       = "idp-golden-path-tfstate-ba25cd9e"
    key          = "ephemeral/terraform.tfstate"
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
      Layer     = "ephemeral"
    }
  }
}

data "terraform_remote_state" "persistent" {
  backend = "s3"
  config = {
    bucket = "idp-golden-path-tfstate-ba25cd9e"
    key    = "persistent/terraform.tfstate"
    region = "ap-northeast-1"
  }
}

data "terraform_remote_state" "ipam" {
  backend = "s3"
  config = {
    bucket = "idp-golden-path-tfstate-ba25cd9e"
    key    = "ipam/terraform.tfstate"
    region = "ap-northeast-1"
  }
}

locals {
  name            = "idp-golden-path"
  domain_name     = data.terraform_remote_state.persistent.outputs.domain_name
  zone_id         = data.terraform_remote_state.persistent.outputs.zone_id
  certificate_arn = data.terraform_remote_state.persistent.outputs.certificate_arn
  ecr_url         = data.terraform_remote_state.persistent.outputs.ecr_repository_url
  techdocs_bucket = data.terraform_remote_state.persistent.outputs.techdocs_bucket_name
  azs             = ["${var.region}a", "${var.region}c"]
}
