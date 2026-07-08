# 本番デプロイ Runbook（検証サイクル）

[ADR 0009](../adr/0009-production-deployment-on-ecs-fargate.md) のライフサイクル運用
（検証時だけ apply → 動作確認 → destroy）の実施手順。
deploy / destroy の実行は [ADR 0010](../adr/0010-ci-driven-deploy-destroy-workflows.md) に基づき
GitHub Actions（workflow_dispatch）で行う。

所要時間の目安: Aurora クラスタの create / destroy が各 10〜15 分かかるため、1 サイクル 60〜90 分を見込む。

## 前提（bootstrap 済みの手動リソース）

以下は Terraform 管理外の一度きりの bootstrap。再構築時のみ参照する。

| リソース | 内容 |
| --- | --- |
| tfstate バケット | `idp-golden-path-tfstate-ba25cd9e`（versioning + SSE + public access block） |
| ドメイン | `idp-golden-path.click`（Route53 Domains で登録。自動作成されたホストゾーンは persistent 層に import 済み） |
| GitHub OAuth App | callback URL `https://idp-golden-path.click/api/auth/github/handler/frame`。Client ID / Secret は Secrets Manager `idp-golden-path/github-oauth`（JSON キー: `clientId` / `clientSecret`）に手動登録 |
| GitHub OIDC provider | `token.actions.githubusercontent.com`（アカウント共通。persistent 層は data source 参照） |
| repo variable | `AWS_CICD_ROLE_ARN` = persistent 層の `github_actions_role_arn` output の値（`gh variable set AWS_CICD_ROLE_ARN --body <ARN>`） |

## 1. persistent 層（初回のみ / 変更時のみ、ローカルから手動）

persistent 層は CI からは触らない（CI ロールの IAM 境界そのものを CI が書き換えられるべきではないため。ADR 0010）。

```bash
cd terraform/persistent
terraform init
terraform apply -var "budget_alert_email=<通知先メールアドレス>"
```

初回のみ、ドメイン登録時に自動作成されたホストゾーンを import する。

```bash
terraform import aws_route53_zone.main <ZONE_ID>
```

## 2. Deploy（GitHub Actions）

Actions タブ → **Deploy** → `Run workflow`（branch: `main`）。または:

```bash
gh workflow run deploy.yml --ref main
gh run watch   # 進捗確認
```

workflow は次を自動実行する: イメージ build & push → shared 層 apply → ephemeral 層 apply →
TechDocs publish → HTTPS readiness の smoke check。イメージタグは実行時の HEAD の short SHA。

## 3. 動作検証（手動）

1. `https://idp-golden-path.click` にアクセスし、HTTPS で開けること
2. GitHub OAuth でサインインできること（User `kmryst` に解決される）
3. Catalog にポートフォリオエンティティが表示されること
4. TechDocs（`/docs/default/component/idp-golden-path`）が S3 publisher 経由で閲覧できること
5. スクリーンショット等の証跡を `docs/operations/verification/` に残す

トラブルシュートは CloudWatch Logs `/ecs/idp-golden-path/backstage` と workflow の実行ログを参照。

## 4. Destroy（GitHub Actions、検証完了後必ず実施）

Actions タブ → **Destroy** → `Run workflow`（branch: `main`、confirm 欄に `destroy` と入力）。または:

```bash
gh workflow run destroy.yml --ref main -f confirm=destroy
gh run watch
```

workflow は ephemeral 層 → shared 層（IPAM も毎回再構築する方針。ADR 0009）の順に destroy し、
最後に残存リソース確認（ECS / RDS / ALB / VPC / NAT gateway / IPAM）まで自動実行する。
残存があれば workflow が失敗するので、実行ログの `Verify no residual resources` を確認して手動で対処する。

persistent 層は destroy **しない**（ドメイン / 証明書 / OAuth 参照 / ECR / TechDocs S3 / OIDC ロール / Budgets）。

## 代替手順（CI が使えない場合のローカル実行）

GitHub Actions が使えない場合のみ、以下をローカルで実行する（CI 導入前の旧手順に相当）。

<details>
<summary>ローカル CLI での deploy / destroy</summary>

### shared 層（IPAM）

```bash
terraform -chdir=terraform/shared init
terraform -chdir=terraform/shared apply
```

### コンテナイメージのビルドと push

リポジトリルートで実行する（ビルドコンテキストはリポジトリルート。カタログ実データを同梱するため）。

```bash
cd backstage
yarn install --immutable
yarn build:backend   # tsc + bundle
cd ..

ECR_URL=$(terraform -chdir=terraform/persistent output -raw ecr_repository_url)
TAG=$(git rev-parse --short HEAD)

aws ecr get-login-password --region ap-northeast-1 | docker login --username AWS --password-stdin "${ECR_URL%%/*}"
docker build -t "$ECR_URL:$TAG" -f backstage/packages/backend/Dockerfile .
docker push "$ECR_URL:$TAG"
```

### ephemeral 層の apply

```bash
terraform -chdir=terraform/ephemeral init
terraform -chdir=terraform/ephemeral apply -var "image_tag=$TAG"
```

### TechDocs の生成と publish（S3）

前提: ホストに mkdocs（`uv tool install mkdocs --with mkdocs-techdocs-core`、ADR 0005）が導入済みであること。

```bash
TECHDOCS_BUCKET=$(terraform -chdir=terraform/persistent output -raw techdocs_bucket_name)

npx @techdocs/cli generate --no-docker --source-dir . --output-dir /tmp/techdocs-site
npx @techdocs/cli publish --publisher-type awsS3 \
  --storage-name "$TECHDOCS_BUCKET" \
  --entity default/Component/idp-golden-path \
  --directory /tmp/techdocs-site
```

### destroy と残存確認

```bash
terraform -chdir=terraform/ephemeral destroy -var "image_tag=$TAG"
terraform -chdir=terraform/shared destroy
```

```bash
aws ecs list-clusters --region ap-northeast-1
aws rds describe-db-clusters --region ap-northeast-1 --query 'DBClusters[].DBClusterIdentifier'
aws elbv2 describe-load-balancers --region ap-northeast-1 --query 'LoadBalancers[].LoadBalancerName'
aws ec2 describe-vpcs --region ap-northeast-1 --filters Name=tag:Project,Values=idp-golden-path --query 'Vpcs[].VpcId'
aws ec2 describe-nat-gateways --region ap-northeast-1 --filter Name=state,Values=available --query 'NatGateways[].NatGatewayId'
```

</details>

## 既知の注意点

- Aurora は min 0 ACU（auto-pause）だが、Backstage 稼働中はコネクションプールによりほぼ発動しない（ADR 0009）
- resume 直後は DB 接続に〜15 秒かかる。app-config 側で接続タイムアウトを 120 秒に設定済み
- AWS Budgets の `Project` タグフィルタはコスト配分タグの有効化（反映まで最大 24 時間）が前提
- Deploy / Destroy workflow は同一 concurrency group のため同時実行されない。実行が queue のまま進まない場合は
  もう一方の workflow の実行状況を確認する
