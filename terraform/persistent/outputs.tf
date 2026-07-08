output "zone_id" {
  description = "Route53 ホストゾーン ID"
  value       = aws_route53_zone.main.zone_id
}

output "domain_name" {
  description = "本番ドメイン"
  value       = var.domain_name
}

output "certificate_arn" {
  description = "ACM 証明書 ARN（検証済み）"
  value       = aws_acm_certificate_validation.main.certificate_arn
}

output "ecr_repository_url" {
  description = "Backstage イメージの ECR リポジトリ URL"
  value       = aws_ecr_repository.backstage.repository_url
}

output "techdocs_bucket_name" {
  description = "TechDocs publisher 用 S3 バケット名"
  value       = aws_s3_bucket.techdocs.bucket
}

output "techdocs_bucket_arn" {
  description = "TechDocs publisher 用 S3 バケット ARN"
  value       = aws_s3_bucket.techdocs.arn
}

output "github_oauth_secret_arn" {
  description = "GitHub OAuth App シークレット（手動登録済み）の ARN"
  value       = data.aws_secretsmanager_secret.github_oauth.arn
}

output "backstage_backend_secret_arn" {
  description = "Backstage backend secret / session 鍵の ARN"
  value       = aws_secretsmanager_secret.backstage_backend.arn
}

output "github_actions_role_arn" {
  description = "GitHub Actions OIDC ロール ARN"
  value       = aws_iam_role.github_actions.arn
}
