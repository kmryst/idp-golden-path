# idp-golden-path

Internal Developer Platform (IDP) のポートフォリオ実装。Backstage をベースに、サービス新規立ち上げ時の「ゴールデンパス」（テンプレート・CI/CD・インフラ・ガードレールの一括提供）をセルフサービス化する。

[terraform-hannibal](https://github.com/kmryst/terraform-hannibal) / [ticket-c2c-platform](https://github.com/kmryst/ticket-c2c-platform) の運用で手作業になっていた ADR・production-readiness チェック・CI ガードレールの再発明を、プラットフォームとして抽象化することを目指す。

## Status

運用基盤（GitHub Flow・CI ガードレール・branch protection・ADR 運用）、Software Catalog / TechDocs に続き、核心機能であるゴールデンパステンプレート（Scaffolder）を実装した。
本番デプロイ構成は ECS Fargate + Aurora Serverless v2 + GitHub OAuth（`https://idp-golden-path.click`）で確定済み（[ADR 0009](./docs/adr/0009-production-deployment-on-ecs-fargate.md) 参照）。
常時稼働はさせず、検証時のみ apply → 動作確認 → destroy するライフサイクルで運用する（persistent 層のみ常設）。
deploy / destroy の実行はローカル CLI ではなく、GitHub Actions の workflow_dispatch（`deploy.yml` / `destroy.yml`、GitHub OIDC 認証）で CI 駆動する（[ADR 0010](./docs/adr/0010-ci-driven-deploy-destroy-workflows.md) 参照）。
2026-07-08 に実 AWS 環境で deploy 成功・readiness・GitHub OAuth リダイレクト配線・destroy まで確認済み
（実ユーザー認証情報が必要な Catalog / TechDocs の目視確認は未実施。[検証記録](./docs/operations/verification/2026-07-08-production-deploy/README.md)）。

## ローカル起動

Backstage アプリ本体は [backstage/](./backstage/) にある。Node.js 22 または 24 が必要。

```bash
cd backstage
yarn install
export GITHUB_TOKEN="$(gh auth token)"   # Scaffolder の publish:github を使う場合
yarn start   # frontend: http://localhost:3000 / backend: http://localhost:7007
```

`yarn start` は `app-config.yaml` と `app-config.development.yaml` を読み込む。
`app-config.local.yaml` が存在する場合は、個人用 override として追加で読み込む。

## 本番デプロイ

本番環境（AWS）への deploy / destroy は、ローカルでの `terraform apply` ではなく、
GitHub Actions の **Deploy** / **Destroy** workflow（workflow_dispatch による手動起動）で実行する。
Destroy は誤爆防止のため確認入力（`destroy` のタイプ）を必須にしている
（[ADR 0010](./docs/adr/0010-ci-driven-deploy-destroy-workflows.md) 参照）。
検証時のみ deploy し、動作確認が済んだら destroy することで、アイドル状態のインフラを残さない。
手順の詳細は [docs/operations/deploy-runbook.md](./docs/operations/deploy-runbook.md) を参照。

## ゴールデンパステンプレート（Scaffolder）

`http://localhost:3000/create` から **Service Baseline (Golden Path)** テンプレートを実行すると、
新規サービスリポジトリが以下の運用基盤つきで GitHub 上に作成され、Software Catalog に登録される。

- CLAUDE.md / CONTRIBUTING.md（軽運用・厳密運用 GitHub Flow、必須 4 ラベル、Conventional Commits）
- ラベル定義（`.github/labels.yml`）と CI ガードレール（PR Policy Check / Commitlint / Markdown Lint / Gitleaks Secret Scan / Sync Labels / Issue Template Check。
  実体は本リポジトリの reusable workflows をタグ固定 `@v1` で参照、[ADR 0008](./docs/adr/0008-ci-guardrails-as-reusable-workflows-with-tag-pinning.md)）
- Issue / PR テンプレートと helper scripts（`scripts/github/`）
- ADR 運用（生成経緯を記録した ADR-0001 つき）と TechDocs / Catalog 対応（`mkdocs.yml` / `catalog-info.yaml`）

入力するのはサービス名・説明・オーナー・ライフサイクル（experimental / production）・公開先リポジトリ（GitHub の owner / repo と可視性）のみ。
テンプレートの実体は [backstage/templates/service-baseline/](./backstage/templates/service-baseline/)、
設計判断は [ADR 0006](./docs/adr/0006-scaffolder-service-baseline-template.md)、
ローカルで実行するための前提条件（GitHub PAT のスコープ等）は
[docs/operations/scaffolder-github-integration.md](./docs/operations/scaffolder-github-integration.md) を参照。

## 設計判断（ADR）

トレードオフを伴う意思決定は [docs/adr/](./docs/adr/README.md) に Architecture Decision Record として記録している。

- [ADR 0001](./docs/adr/0001-adopt-backstage-for-idp-portfolio.md) — IDP ポートフォリオの基盤に Backstage を採用する
- [ADR 0002](./docs/adr/0002-adopt-lightweight-and-strict-github-flow.md) — 既存2リポジトリの軽運用 / 厳密運用 GitHub Flow モデルを踏襲する
- [ADR 0003](./docs/adr/0003-backstage-app-layout-and-local-dev-baseline.md) — Backstage アプリを `backstage/` に配置し、ローカル開発は guest 認証 + インメモリ SQLite を基準とする
- [ADR 0004](./docs/adr/0004-catalog-registration-via-local-stub-locations.md) — 既存リポジトリのカタログ登録は当面 `catalog/` 配下の file location スタブで行う
- [ADR 0005](./docs/adr/0005-techdocs-local-generator.md) — TechDocs はローカル builder + ホスト mkdocs（runIn local）で運用する
- [ADR 0006](./docs/adr/0006-scaffolder-service-baseline-template.md) — Scaffolder ゴールデンパスは「リポジトリ・ガバナンスベースライン」テンプレートとして提供する
- [ADR 0007](./docs/adr/0007-scaffolder-github-app-authentication.md) — Scaffolder の GitHub 連携は個人 PAT を継続し、GitHub App へは移行しない
- [ADR 0008](./docs/adr/0008-ci-guardrails-as-reusable-workflows-with-tag-pinning.md) — CI ガードレールを reusable workflows として提供し、タグ固定（`@v1`）で参照する
- [ADR 0009](./docs/adr/0009-production-deployment-on-ecs-fargate.md) — 本番デプロイは ECS Fargate + Aurora Serverless v2 + GitHub OAuth とし、検証時のみ apply する 3 層 state 分離で運用する
- [ADR 0010](./docs/adr/0010-ci-driven-deploy-destroy-workflows.md) — 本番デプロイ / 破棄は workflow_dispatch の GitHub Actions で実行する
- [ADR 0011](./docs/adr/0011-catalog-registration-via-repository-owned-catalog-info.md) — 既存リポジトリのカタログ登録を各リポジトリ所有の `catalog-info.yaml` + GitHub URL location へ移行する
- [ADR 0012](./docs/adr/0012-split-backstage-auth-config-by-environment.md) — Backstage の auth provider 設定を環境別 config に分離する

## 開発への参加

Issue / Branch / Commit / PR / Label の運用ルールは [CONTRIBUTING.md](./CONTRIBUTING.md) を参照。
main ブランチ保護設定は [docs/operations/branch-protection.md](./docs/operations/branch-protection.md) に記録している。
CI セキュリティスキャン（Gitleaks / Dependency Audit / CodeQL）の運用は [docs/operations/security-scanning.md](./docs/operations/security-scanning.md) に記録している。
本番デプロイ / destroy の実施手順は [docs/operations/deploy-runbook.md](./docs/operations/deploy-runbook.md) に記録している。
