output "ipam_pool_id" {
  description = "ephemeral 層の VPC が CIDR を払い出す IPAM プール ID"
  value       = aws_vpc_ipam_pool.private.id
}

output "ipam_pool_cidr" {
  description = "IPAM プールの CIDR 範囲"
  value       = aws_vpc_ipam_pool_cidr.private.cidr
}
