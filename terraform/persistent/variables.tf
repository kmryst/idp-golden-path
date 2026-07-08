variable "region" {
  description = "AWS リージョン"
  type        = string
  default     = "ap-northeast-1"
}

variable "domain_name" {
  description = "本番ドメイン（Route53 登録済み）"
  type        = string
  default     = "idp-golden-path.click"
}

variable "budget_alert_email" {
  description = "AWS Budgets アラートの通知先メールアドレス"
  type        = string
}
