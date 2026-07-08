output "app_url" {
  description = "Backstage の URL"
  value       = "https://${local.domain_name}"
}

output "alb_dns_name" {
  description = "ALB の DNS 名（apply 毎に変わる）"
  value       = aws_lb.main.dns_name
}

output "vpc_cidr" {
  description = "IPAM から払い出された VPC CIDR"
  value       = aws_vpc.main.cidr_block
}

output "aurora_endpoint" {
  description = "Aurora クラスタの writer エンドポイント"
  value       = aws_rds_cluster.main.endpoint
}

output "ecs_cluster_name" {
  description = "ECS クラスタ名"
  value       = aws_ecs_cluster.main.name
}
