# idp-golden-path

Internal Developer Platform (IDP) のポートフォリオ実装。Backstage をベースに、サービス新規立ち上げ時の「ゴールデンパス」（テンプレート・CI/CD・インフラ・ガードレールの一括提供）をセルフサービス化する。

[terraform-hannibal](https://github.com/kmryst/terraform-hannibal) / [ticket-c2c-platform](https://github.com/kmryst/ticket-c2c-platform) の運用で手作業になっていた ADR・production-readiness チェック・CI ガードレールの再発明を、プラットフォームとして抽象化することを目指す。

## Status

運用基盤（GitHub Flow・CI ガードレール・branch protection・ADR 運用）の整備が完了し、Backstage アプリの実装を開始した。現段階はローカル開発のみ（デプロイ先は未確定、[ADR 0003](./docs/adr/0003-backstage-app-layout-and-local-dev-baseline.md) 参照）。

## ローカル起動

Backstage アプリ本体は [backstage/](./backstage/) にある。Node.js 22 または 24 が必要。

```bash
cd backstage
yarn install
yarn start   # frontend: http://localhost:3000 / backend: http://localhost:7007
```

## 設計判断（ADR）

トレードオフを伴う意思決定は [docs/adr/](./docs/adr/README.md) に Architecture Decision Record として記録している。

- [ADR 0001](./docs/adr/0001-adopt-backstage-for-idp-portfolio.md) — IDP ポートフォリオの基盤に Backstage を採用する
- [ADR 0002](./docs/adr/0002-adopt-lightweight-and-strict-github-flow.md) — 既存2リポジトリの軽運用 / 厳密運用 GitHub Flow モデルを踏襲する
- [ADR 0003](./docs/adr/0003-backstage-app-layout-and-local-dev-baseline.md) — Backstage アプリを `backstage/` に配置し、ローカル開発は guest 認証 + インメモリ SQLite を基準とする

## 開発への参加

Issue / Branch / Commit / PR / Label の運用ルールは [CONTRIBUTING.md](./CONTRIBUTING.md) を参照。
main ブランチ保護設定は [docs/operations/branch-protection.md](./docs/operations/branch-protection.md) に記録している。
