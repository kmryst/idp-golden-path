# terraform/ — 3 層 state 分離

[ADR 0009](../docs/adr/0009-production-deployment-on-ecs-fargate.md) に基づく本番インフラ。
デプロイ・destroy の手順は [deploy-runbook.md](../docs/operations/deploy-runbook.md) を参照。

| ディレクトリ | ライフサイクル | 内容 |
| --- | --- | --- |
| `persistent/` | 常設（destroy しない） | Route53 ゾーン、ACM、ECR、TechDocs S3、backend secret、GitHub OIDC ロール、Budgets |
| `shared/` | 検証サイクル毎に再構築可 | VPC IPAM 本体 + プール（`10.16.0.0/12`） |
| `ephemeral/` | 検証毎に apply → destroy | VPC、ECS Fargate / ALB、Aurora Serverless v2、ALB 向け alias レコード |

state は S3 backend（`idp-golden-path-tfstate-ba25cd9e`）に層ごとの key で分離し、
S3 ネイティブロック（`use_lockfile`）を使う。
