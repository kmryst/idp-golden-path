# ipam 層（アカウント共有基盤）: VPC IPAM 本体とプール
# 設計判断は ADR 0009 を参照。
#
# アカウント横断の共有基盤のため idp-golden-path 単体のライフサイクルに縛らない位置づけで
# state を分離するが、検証サイクル毎の destroy / 再構築は許容する。
#
# - プール CIDR は 10.16.0.0/12（既存 2 プロジェクトが重複使用中の 10.0.0.0/16 を含まない。
#   docs/operations/network-cidr-ledger.md 参照）
# - 既存 VPC の自動 import は有効化しない（IPAM に重複の承認/抑止機能はなく観測のみのため）

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
    key          = "ipam/terraform.tfstate"
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
      Layer     = "ipam"
    }
  }
}

resource "aws_vpc_ipam" "main" {
  description = "Account-level IPAM (managed in idp-golden-path/terraform/ipam)"

  operating_regions {
    region_name = var.region
  }

  # 設計時は free tier を想定していたが、free tier では private scope への
  # プール作成が API エラー（UnsupportedOperation）で拒否されることを初回 apply 時に確認した。
  # advanced tier は「アクティブ IP アドレス単位の時間課金」のみで、
  # 検証時のみ apply → destroy する運用（ADR 0009/0010）ではアクティブ IP が
  # 十数個 x 数時間に収まるため、1 サイクルあたり数セント未満。Budgets の $5/月内で許容する。
  # 課金対象には同リージョンの他プロジェクト（terraform-hannibal / ticket-c2c）の
  # アクティブ IP も含まれ得るが、両者も destroy 運用のため、全プロジェクト同時稼働でも
  # 数十 IP x 数時間のオーダーに収まる。
  tier = "advanced"
}

resource "aws_vpc_ipam_pool" "private" {
  description    = "idp-golden-path private pool (10.16.0.0/12)"
  address_family = "ipv4"
  ipam_scope_id  = aws_vpc_ipam.main.private_default_scope_id
  locale         = var.region

  # 既存 VPC の自動 import はしない（ADR 0009）
  auto_import = false
}

resource "aws_vpc_ipam_pool_cidr" "private" {
  ipam_pool_id = aws_vpc_ipam_pool.private.id
  cidr         = "10.16.0.0/12"
}
