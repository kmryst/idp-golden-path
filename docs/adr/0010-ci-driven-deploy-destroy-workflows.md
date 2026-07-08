# 0010. 本番デプロイ / 破棄は workflow_dispatch の GitHub Actions で実行する

## ステータス

Accepted

## 日付

2026-07-09

## 決定内容

[ADR 0009](./0009-production-deployment-on-ecs-fargate.md) のライフサイクル運用
（検証時のみ apply → 動作確認 → destroy）の実行手段を、ローカル CLI から GitHub Actions に移す。

### workflow の構成 — 手動起動のみの 2 本立て

- `deploy.yml`（Deploy）: イメージ build & push → ipam 層 apply → ephemeral 層 apply →
  TechDocs publish → HTTPS readiness の smoke check
- `destroy.yml`（Destroy）: ephemeral 層 destroy → ipam 層 destroy → 残存リソース確認
- トリガーは両方とも **workflow_dispatch のみ**。スケジュール実行・push 連動は誤爆（意図しない課金リソース作成 /
  稼働環境の破棄）防止のため入れない
- Destroy は確認入力（`destroy` のタイプ）を必須にする
- 両 workflow は同一の concurrency group（`production-lifecycle`）に属し、同時実行による state 破損を防ぐ
- persistent 層はどちらの workflow でも触らない。persistent 層の apply は引き続きローカルからの手動実行とする
  （IAM 境界そのものを CI が書き換えられるべきではないため）

### AWS 認証 — persistent 層の既存 OIDC ロールを使う

- persistent 層に用意済みだった GitHub OIDC ロール（`idp-golden-path-github-actions`）を使う。
  ロール ARN は repo variable `AWS_CICD_ROLE_ARN`（terraform-hannibal と同じ命名）で参照する
- ロールの権限は「イメージ push + TechDocs publish」から「ephemeral / ipam 層の terraform apply / destroy」まで
  拡張した（PR [#70](https://github.com/kmryst/idp-golden-path/pull/70)）。境界設計は次の通り
  - **tfstate**: 読み取りは全層、書き込みは `ephemeral/*` / `ipam/*` キーのみ。CI から persistent 層の state は壊せない
  - **ec2 / ecs / elasticloadbalancing / rds / logs**: `aws:RequestedRegion` 条件でリージョン境界を引く
  - **IAM**: ロール管理は `role/idp-golden-path-*` に名前限定。`iam:CreateRole` / `iam:PutRolePolicy` は
    `iam:PermissionsBoundary` 条件で「CI 自身と同じ boundary を付けたロール」に対してのみ許可し、
    CI が任意権限のロールを作る権限昇格経路を塞ぐ。managed policy の attach は
    `AmazonECSTaskExecutionRolePolicy` のみ。`iam:PassRole` は `ecs-tasks.amazonaws.com` 限定
  - **boundary の共用**: 上記の条件設計の帰結として、ephemeral 層のタスクロール / タスク実行ロールにも
    CI と同じ permissions boundary を強制する。タスク実行ロールに必要な `secretsmanager:GetSecretValue`
    （対象 secret 限定）は boundary 側にのみ置き、CI の inline policy には含めない
    （CI ロール自身は Secrets Manager の秘密値を読めない）

### 既知の受容リスク

- **persistent state 内の秘密値**: `terraform_remote_state` は outputs だけでなく state ファイル全体を取得するため、
  CI ロールは persistent state 内の `random_password` 生成値（backend secret / session 鍵）を読める。
  トリガーが workflow_dispatch のみ・実行されるのは main にマージ済みの workflow 定義・リポジトリ書き込み権限者が
  本人のみであることから受容する
- **`ec2:*` の到達範囲**: ec2 の多くの API（Describe 系・IPAM 系）はリソースタグ条件を評価できないため、
  タグで絞らずリージョン条件のみとした。同一リージョンの他プロジェクト（terraform-hannibal / ticket-c2c-platform）の
  VPC にも API 上は届き得る。terraform の実行対象がリポジトリ内の HCL に限られることと、上記と同じ実行経路の
  信頼を根拠に受容する

## 背景

ADR 0009 の運用は「destroy されている状態が平常」であり、検証のたびに deploy / destroy を繰り返す。
runbook はローカル CLI 手順（8 ステップ、1 サイクル 60〜90 分のうち手作業が多数）で書かれており、
persistent 層に用意した GitHub OIDC ロールも「将来の CI 用」のまま使われていなかった。
反復頻度の高い操作ほど自動化の投資対効果が高く、また「クリック 1 つで環境を作って壊せる」こと自体が
IDP ポートフォリオとして示したい能力である。

## 検討した選択肢

### ローカル CLI 継続（不採用）

- 長所: 追加実装ゼロ。IAM 拡張も不要
- 短所: 毎サイクルの手作業が多く、手順の再現性がオペレータの注意力に依存する。OIDC ロールが宙に浮いたまま

### 1 本の workflow で deploy / destroy を input 選択（不採用）

- 長所: ファイルが 1 つで済む
- 短所: 「破棄」という不可逆操作が「構築」と同じ入口に同居し、選択ミスの余地が生まれる。
  Actions の実行履歴でも deploy と destroy が混ざり、監査性が下がる。
  既存 2 プロジェクト（terraform-hannibal の deploy.yml / destroy.yml 等）とも構成が揃わない

### 手動起動のみの 2 本立て（採択）

- 長所: 入口が分離され、Destroy 側にだけ確認入力を課せる。既存プロジェクトとパターンが揃う
- 短所: 共通部分（認証・terraform セットアップ）が 2 ファイルに重複する（許容）

### スケジュール destroy（夜間自動破棄）の追加（不採用）

- 検証セッションの途中で環境が消えるリスクと、自動トリガー全般を入れないという誤爆防止方針に反するため見送る。
  コスト暴走は AWS Budgets（ADR 0009）と ECS の deployment circuit breaker で検知・抑制する

## 採択理由

- 反復頻度が最も高い操作（deploy / destroy）が 1 クリックになり、runbook の手作業はドメイン検証と
  persistent 層の変更時のみに縮む
- 用意済みの OIDC ロールが本来の目的で機能し、静的クレデンシャルを一切リポジトリに置かない
- 権限拡張は boundary・state 書き込み分離・IAM 条件で境界を引き、受容するリスクを本 ADR に明文化した

## 影響

- `.github/workflows/deploy.yml` / `destroy.yml` を新設する
- repo variable `AWS_CICD_ROLE_ARN` に persistent 層の `github_actions_role_arn` output の値を設定する
- `docs/operations/deploy-runbook.md` を CI 駆動の手順に書き換える。ローカル CLI 手順は
  bootstrap 時・CI が使えない場合の代替手順として残す
- ephemeral 層のタスクロール / タスク実行ロールに permissions boundary の指定が必須になる（PR #70 で対応済み）
- branch protection の required status checks には影響しない（両 workflow とも PR チェックではない）

## 関連

- [ADR 0009](./0009-production-deployment-on-ecs-fargate.md) — 本番デプロイ構成と 3 層 state 分離（本 ADR はその実行手段を変更）
- [runbook](../operations/deploy-runbook.md)
- Issue [#69](https://github.com/kmryst/idp-golden-path/issues/69) / PR [#70](https://github.com/kmryst/idp-golden-path/pull/70)
