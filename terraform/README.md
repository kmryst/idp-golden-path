# terraform/ — 3 層 state 分離

[ADR 0009](../docs/adr/0009-production-deployment-on-ecs-fargate.md) に基づく本番インフラ。
デプロイ・destroy の手順は [deploy-runbook.md](../docs/operations/deploy-runbook.md) を参照。

| ディレクトリ | ライフサイクル | 内容 |
| --- | --- | --- |
| `persistent/` | 常設（destroy しない） | Route53 ゾーン、ACM、ECR、TechDocs S3、backend secret、GitHub OIDC ロール、Budgets |
| `ipam/` | 検証サイクル毎に再構築可 | VPC IPAM 本体 + プール（`10.16.0.0/12`） |
| `ephemeral/` | 検証毎に apply → destroy | VPC、ECS Fargate / ALB、Aurora Serverless v2、ALB 向け alias レコード |

state は S3 backend（`idp-golden-path-tfstate-ba25cd9e`）に層ごとの key で分離し、
S3 ネイティブロック（`use_lockfile`）を使う。

## 層名 `ephemeral` と Terraform 言語構文の `ephemeral` は無関係

Terraform 1.10 で言語構文としての `ephemeral`（ブロック型キーワード）が導入された。
その語義は「**state / plan に永続化されない**」値・リソースである
（出典: <https://developer.hashicorp.com/terraform/language/resources/ephemeral>）。

一方、本リポジトリの層名 `persistent` / `ephemeral` / `ipam` は
**リソースの寿命と役割**（検証毎に apply → destroy する層かどうか）を指しており、
言語構文の `ephemeral` とは無関係である。むしろ語義は逆で、`ephemeral/` は
state を通常どおり `ephemeral/terraform.tfstate`（上記 S3 backend）へ**永続化する**
ルートモジュールである。

なお「ephemeral environment（短命な検証環境）」は業界標準語であり、その用法は問題ない。
衝突しているのは層名 / state キーとしての `ephemeral` のみである。
この衝突を認識した上で改名しない判断とその理由（state キー・IAM 条件・タグ・CI への波及範囲）は
[ADR 0010 の追記（2026-08-27）](../docs/adr/0010-ci-driven-deploy-destroy-workflows.md)に記録している。

## Terraform CLI のバージョン

**1.14.8**（3 リポジトリ共通の標準。[ADR 0014](../docs/adr/0014-terraform-toolchain-version-standardization.md)）。

- ローカルの正本はリポジトリルートの `.mise.toml`。`mise install` で取得する
- CI の pin は `.github/workflows/deploy.yml` / `destroy.yml` の `TERRAFORM_VERSION`
- 両者が一致していることは Toolchain Version Check（`.github/workflows/toolchain-version-check.yml`）が PR ごとに検査する
- state は前方互換がなく、記録された `terraform_version` より古い CLI での操作を拒否する。
  バージョンを下げないこと。特に `persistent` 層は実リソースを持ったまま state が 1.14.8 で記録されている
