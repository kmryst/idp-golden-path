# 0009. 本番デプロイは ECS Fargate + Aurora Serverless v2 + GitHub OAuth とし、検証時のみ apply する 3 層 state 分離で運用する

## ステータス

Accepted

## 日付

2026-07-08

## 決定内容

[ADR 0003](./0003-backstage-app-layout-and-local-dev-baseline.md) で保留していた本番デプロイ構成を、次の通り確定する。
本設計はユーザーとの対話および DevOps / SRE / PE 観点のレビュー 2 回を経て確定したものである。

### Compute — 素の ECS Fargate + 自前 ALB

- ALB は internet-facing とし public サブネットに、タスクは private サブネットに配置する
- タスク定義・ALB・ターゲットグループ・リスナー・セキュリティグループは Terraform で明示的に記述する
- イメージ pull / 外部通信用に NAT ゲートウェイを 1 本置く
- タスクサイズは最低 1 vCPU / 2 GB、`health_check_grace_period_seconds` は 60 秒以上
- ヘルスチェックパスは Backstage backend の実エンドポイント `/.backstage/health/v1/readiness` を使う
  （設計時は `/healthcheck` を想定していたが、新 backend system（`backend-defaults`）が公開するのは
  `/.backstage/health/v1/liveness` / `readiness` であることを実装時に確認したため、実在するパスに補正した）

### DB — Aurora Serverless v2（PostgreSQL 互換）

- 選定理由はワークロード要件ではなく、「ACU 単位のキャパシティ管理自動化」を実運用で学ぶという学習テーマである。
  ポートフォリオ規模のワークロード要件だけなら RDS PostgreSQL 単一インスタンスで十分である（後述）
- auto-pause（min 0 ACU）を設定するが、Backstage は knex のコネクションプールを常時保持するため、
  Backstage 稼働中に auto-pause はほぼ発動しない。「destroy せず一時停止」という節約策は
  Backstage 自体も止める場合にのみ有効で、本 ADR の destroy 運用（後述）とはほぼ排他である
- resume 時の再開レイテンシ（〜15 秒）を見込み、knex の接続タイムアウト / プール取得タイムアウトを長め（120 秒）に設定する
- 検証毎に破棄する前提のため `skip_final_snapshot = true` / `deletion_protection = false` とする

### 認証 — GitHub OAuth App（classic）

- 目的はログイン（本人確認）のみで、インストール単位のスコープ管理が不要なため、GitHub App ではなく OAuth App(classic) を使う
- Client ID / Secret は AWS Secrets Manager `idp-golden-path/github-oauth`（永続層）に置き、ECS タスクへ直接注入する。
  リポジトリ・Terraform state・ログには値を置かない
- Backstage の backend secret / session 鍵も Secrets Manager の永続層に置き、apply 毎の再生成でセッションが無効化されるのを避ける
- サインイン解決は `usernameMatchingUserEntityName` resolver（`catalog/org.yaml` の User `kmryst` に解決）

### ドメイン / TLS

- 新規登録した `idp-golden-path.click`（Route53）を固定ドメインとして使う
- Route53 ホストゾーン + ACM 証明書 + OAuth App 参照は「永続層」として state 分離する
  （OAuth callback URL が固定ドメインに紐づくため、ここが破棄されると認証も壊れる）

### TechDocs — S3 publisher

- 本番は `builder: external` + `publisher: awsS3` とする（本番標準パターンの学習が目的）
- ドキュメントは techdocs-cli で生成し S3 へ publish する。backend は S3 から配信するのみ
- [ADR 0005](./0005-techdocs-local-generator.md) のローカル builder 構成は、ローカル開発の基準としては引き続き有効

### Terraform state 分離（3 層）

| 層 | ライフサイクル | 内容 |
| --- | --- | --- |
| persistent（永続層） | 常設。destroy しない | Route53 ホストゾーン、ACM 証明書、GitHub OAuth シークレット参照、Backstage backend secret、ECR、TechDocs 用 S3、GitHub OIDC ロール + permissions boundary、AWS Budgets |
| shared（アカウント共有層） | 検証サイクル毎に再構築可 | VPC IPAM 本体とプール。アカウント横断の共有基盤のため、idp-golden-path 単体のライフサイクルに縛らない位置づけとして分離 |
| ephemeral（エフェメラル層） | 検証毎に apply → destroy | VPC、ECS Fargate / ALB / タスク、Aurora Serverless v2、ALB 向け Route53 alias レコード（ALB の DNS 名は apply 毎に変わるためここに属する。ホストゾーン自体は data source で永続層を参照） |

### ネットワーク / CIDR — VPC IPAM からの払い出し

- 同一 AWS アカウント（ap-northeast-1）内に専用 VPC を新規に切る
  （ticket-c2c-platform / terraform-hannibal と同じ「state 分離 + IAM 境界」の粒度）
- 新規 VPC の CIDR は IPAM プールから払い出す。プールの CIDR 空間は、既存 2 プロジェクトが重複使用している
  `10.0.0.0/16` を含まない `10.16.0.0/12` とする
- 既存 VPC の自動 import は有効化しない（IPAM に重複を承認 / 抑止する機能はなく観測のみのため）
- 既存 2 プロジェクトの `10.0.0.0/16` 重複は IPAM 側では対応せず、
  [CIDR 台帳](../operations/network-cidr-ledger.md) に既知の事実として記録する

### コストガードレール

- AWS Budgets で idp-golden-path 単体（`Project=idp-golden-path` タグフィルタ）に月 $5 の予算アラートを設定する（永続層）
- タグフィルタ付き Budget が機能するには、`Project` タグをコスト配分タグとして有効化する必要がある
  （有効化後、反映まで最大 24 時間かかる点は既知の制約として受け入れる）

### ライフサイクル運用（最重要）

- **常時稼働させない。** terraform-hannibal / ticket-c2c-platform と同じ
  「検証時だけ apply → 動作確認（スクリーンショット等の証跡）→ destroy」の運用とする
- ephemeral 層と shared 層は毎回 destroy / 再構築し、persistent 層のみ維持する
- Aurora クラスタの create / destroy は各 10〜15 分かかるため、1 検証サイクルの所要時間として見込む

## 背景

ADR 0003 は「デプロイ先（AWS 構成・本番 DB・本番認証方式）はデプロイ着手時に別 ADR で確定する」と意図的に保留していた。
Scaffolder ゴールデンパス（ADR 0006）までのローカル実装が完了し、ポートフォリオとして
「本番相当の構成を実際に構築・検証できる」ことを示すフェーズに入ったため、本 ADR でデプロイ構成を確定する。

前提となる制約は次の通り。

- 個人ポートフォリオであり、常時稼働はコストに見合わない（既存 2 プロジェクトも検証時のみ apply する運用）
- 一方で「動く構成を作れる」証跡（実ドメイン + HTTPS + 実認証での動作確認）は必要
- 既存プロジェクトと同一 AWS アカウントを共有するため、ネットワーク・コストの境界を明示する必要がある

## 検討した選択肢

### Compute

#### App Runner（選定不可）

当初の第一候補だったが、AWS が 2026-04-30 付で新規顧客の受付を終了（サンセット）しており選定できないことが判明した。

#### ECS Express Mode（不採用）

App Runner の代替として検討したが、`networkConfiguration.Subnets` が ALB とタスクの両方に同一適用される仕様のため、
「ALB は public・タスクは private」という標準分離ができない。private サブネットを指定すると internal ALB になり、
ブラウザからの GitHub OAuth ログイン到達性が成立しないため不採用とした。

#### 素の ECS Fargate + 自前 ALB（採択）

- 長所: ALB / タスクのサブネット分離・セキュリティグループ・ヘルスチェックを Terraform で明示的に制御でき、
  本番標準のネットワーク分離パターンをそのまま示せる
- 短所: Express Mode に比べ記述量が多い。NAT ゲートウェイ / ALB の時間課金が発生する（destroy 運用で許容）

#### EKS / EC2（不採用）

Kubernetes クラスタ運用・ノード管理は本ポートフォリオの主題（IDP / ゴールデンパス）に対して過剰であり、
検証サイクルの立ち上げ時間・コストも大きい。

### DB

#### RDS PostgreSQL 単一インスタンス（不採用）

- 長所: 構成が最も単純で安価。ポートフォリオ規模のワークロード要件だけならこれで十分
- 不採用理由: ワークロード要件では Aurora を正当化できないが、本プロジェクトの目的は学習テーマの実践であり、
  「ACU 単位のキャパシティ管理自動化（Serverless v2）」を実際に構築・観察する価値を優先した

#### Aurora Serverless v2（採択）

- 長所: ACU ベースのスケーリング・auto-pause（min 0 ACU）という Serverless v2 固有の運用特性を学べる
- 短所・正直な注記: Backstage は knex のコネクションプールを常時保持するため、稼働中に auto-pause はほぼ発動しない。
  また resume に〜15 秒かかるため、接続タイムアウトを長めに設定する必要がある。
  auto-pause による節約は「destroy せず一時停止」する場合のみ有効で、本 ADR の destroy 運用とはほぼ排他である

### 認証

#### GitHub App（不採用）

インストール単位の権限管理・細粒度スコープは「ログインのみ」という要件に対して過剰（ADR 0007 で Scaffolder 用途でも見送り済み）。

#### GitHub OAuth App classic（採択）

ログイン（本人確認）のみが目的で、必要スコープが最小。callback URL は固定ドメインに紐づけ永続層として扱う。

### TechDocs 配信

#### ローカル builder 継続（不採用）

Fargate タスク内で mkdocs を都度実行する構成は、コンテナに Python / mkdocs を同梱する必要があり、
本番標準（CI 生成 + external publisher）から外れる。

#### S3 publisher + external builder（採択）

本番標準パターン。生成（techdocs-cli）と配信（S3）が分離され、タスクはステートレスに保てる。

### state 分離の粒度

単一 state 案（全リソースを 1 state で管理）は、「検証毎に destroy する層」と「破棄すると認証・ドメインが壊れる層」が
同居しリスクが高いため不採用。ライフサイクルの異なる 3 層に分離した。

## 採択理由

- 「ALB は public・タスクは private」という本番標準のネットワーク分離を、マネージド抽象（App Runner / Express Mode）の
  制約に妨げられず Terraform で明示的に示せる
- 固定ドメイン・OAuth App・証明書という「破棄できないもの」と、時間課金リソースという「破棄すべきもの」を
  state 境界で分離することで、検証時のみ apply する運用を安全に繰り返せる
- Aurora Serverless v2 / VPC IPAM / AWS Budgets はいずれも既存 2 プロジェクトで扱っていない領域で、
  ポートフォリオとしての学習面の拡張になる

## 影響

- `terraform/persistent/` / `terraform/shared/` / `terraform/ephemeral/` を新設し、それぞれ独立した S3 backend state を持つ
- Backstage 側は GitHub auth provider の追加、本番 DB 接続（SSL + 長めのタイムアウト）、TechDocs S3 publisher 対応、
  カタログ実データのイメージ同梱（Dockerfile のビルドコンテキストをリポジトリルートに変更）が必要（別 Issue）
- デプロイ・検証・destroy の手順は `docs/operations/deploy-runbook.md` に記録する
- ネットワーク CIDR の割り当ては `docs/operations/network-cidr-ledger.md` を台帳とする
- CLAUDE.md / README.md の「デプロイ先は未確定」の記述を本 ADR 参照に更新する
- ADR 0005 の「デプロイ時は別 ADR で判断する」は本 ADR で確定した（ローカル開発の基準構成としての ADR 0005 は引き続き有効）

## 関連

- [ADR 0001](./0001-adopt-backstage-for-idp-portfolio.md) — Backstage 採用の判断
- [ADR 0003](./0003-backstage-app-layout-and-local-dev-baseline.md) — 本 ADR が保留を引き継いだローカル開発基準
- [ADR 0005](./0005-techdocs-local-generator.md) — TechDocs のローカル構成（本番配信は本 ADR で S3 publisher に確定）
- [ADR 0007](./0007-scaffolder-github-app-authentication.md) — GitHub App を見送った経緯（認証でも同じ判断を踏襲）
- [ADR 0010](./0010-ci-driven-deploy-destroy-workflows.md) — deploy / destroy の実行手段を GitHub Actions（workflow_dispatch）に変更
- [CIDR 台帳](../operations/network-cidr-ledger.md)
- Issue [#61](https://github.com/kmryst/idp-golden-path/issues/61)
