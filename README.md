# idp-golden-path

Internal Developer Platform (IDP) のポートフォリオ実装。Backstage をベースに、サービス新規立ち上げ時の「ゴールデンパス」（テンプレート・CI/CD・インフラ・ガードレールの一括提供）をセルフサービス化する。

[terraform-hannibal](https://github.com/kmryst/terraform-hannibal) / [ticket-c2c-platform](https://github.com/kmryst/ticket-c2c-platform) の運用で手作業になっていた ADR・production-readiness チェック・CI ガードレールの再発明を、プラットフォームとして抽象化することを目指す。

## Status

運用基盤（GitHub Flow・CI ガードレール・branch protection・ADR 運用）、Software Catalog / TechDocs に続き、核心機能であるゴールデンパステンプレート（Scaffolder）を実装した。現段階はローカル開発のみ（デプロイ先は未確定、[ADR 0003](./docs/adr/0003-backstage-app-layout-and-local-dev-baseline.md) 参照）。

## ローカル起動

Backstage アプリ本体は [backstage/](./backstage/) にある。Node.js 22 または 24 が必要。

```bash
cd backstage
yarn install
export GITHUB_TOKEN="$(gh auth token)"   # Scaffolder の publish:github を使う場合
yarn start   # frontend: http://localhost:3000 / backend: http://localhost:7007
```

## ゴールデンパステンプレート（Scaffolder）

`http://localhost:3000/create` から **Service Baseline (Golden Path)** テンプレートを実行すると、
新規サービスリポジトリが以下の運用基盤つきで GitHub 上に作成され、Software Catalog に登録される。

- CLAUDE.md / CONTRIBUTING.md（軽運用・厳密運用 GitHub Flow、必須 4 ラベル、Conventional Commits）
- ラベル定義（`.github/labels.yml`）と CI ガードレール（PR Policy Check / Commitlint / Markdown Lint / Gitleaks Secret Scan / Sync Labels。
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

## 開発への参加

Issue / Branch / Commit / PR / Label の運用ルールは [CONTRIBUTING.md](./CONTRIBUTING.md) を参照。
main ブランチ保護設定は [docs/operations/branch-protection.md](./docs/operations/branch-protection.md) に記録している。
CI セキュリティスキャン（Gitleaks / Dependency Audit / CodeQL）の運用は [docs/operations/security-scanning.md](./docs/operations/security-scanning.md) に記録している。
