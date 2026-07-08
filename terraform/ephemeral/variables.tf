variable "region" {
  description = "AWS リージョン"
  type        = string
  default     = "ap-northeast-1"
}

variable "image_tag" {
  description = "デプロイする Backstage イメージのタグ（ECR に push 済みであること）"
  type        = string
}

variable "aurora_engine_version" {
  description = "Aurora PostgreSQL エンジンバージョン（Serverless v2 の 0 ACU auto-pause 対応版）"
  type        = string
  default     = "17.7"
}
