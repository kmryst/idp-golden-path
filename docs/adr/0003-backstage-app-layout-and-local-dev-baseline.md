# 0003. Backstage アプリを backstage/ サブディレクトリに置き、ローカル開発は guest 認証 + インメモリ SQLite を基準とする

## ステータス

Accepted

## 日付

2026-07-07

## 決定内容

Backstage アプリ本体（`@backstage/create-app` で scaffold した Yarn workspaces モノレポ）を、リポジトリルートではなく `backstage/` サブディレクトリに配置する。

ローカル開発の基準構成は、scaffold のデフォルトをそのまま採用する。

- パッケージマネージャ: Yarn 4（`backstage/.yarn/releases/` に vendored、`packageManager` フィールドで固定）
- Node.js: `22 || 24`（既存 CI の Node 24 と整合）
- データベース: better-sqlite3 のインメモリ（`:memory:`）
- 認証: guest provider のみ（`auth.providers.guest`）
- 起動: `cd backstage && yarn start`（frontend :3000 / backend :7007）

デプロイ先（AWS 構成・本番 DB・本番認証方式）は本 ADR では決めず、デプロイ着手時に別 ADR で確定する。

## 背景

リポジトリルートには、リポジトリ運用ツーリング（markdownlint-cli2 / commitlint）を持つ npm ベースの `package.json` が既に存在する。一方 `@backstage/create-app` は、ルートに独自の `package.json` を持つ Yarn workspaces モノレポを生成するため、ルート直下に scaffold すると既存ツーリングと衝突する。

また、現段階（[ADR 0001](./0001-adopt-backstage-for-idp-portfolio.md)）はローカル動作確認が目的であり、外部依存（PostgreSQL、OAuth プロバイダ）を持ち込む必然性がない。

## 検討した選択肢

### backstage/ サブディレクトリに配置（採択）

- 長所: 既存のリポジトリ運用ツーリング（npm / markdownlint / commitlint）と Backstage の Yarn 4 モノレポが互いに独立し、衝突しない
- 長所: 将来 `terraform/` や `templates/` などプラットフォームの他の構成要素を並列に置ける
- 短所: `cd backstage` の一段が挟まる。CI でも working-directory 指定が必要

### リポジトリルートに配置

- 長所: Backstage 標準のリポジトリレイアウトそのままで、公式ドキュメントとの対応が分かりやすい
- 短所: 既存の `package.json`（npm）と create-app 生成の `package.json`（Yarn 4 workspaces）が衝突し、運用ツーリングの移植作業が発生する
- 短所: リポジトリの正本ドキュメント群と生成コードがルートで混在する

### 別リポジトリに分離

- 長所: 運用基盤リポジトリとアプリリポジトリの関心が完全分離できる
- 短所: ポートフォリオとして「運用基盤 + IDP 実装」を一体で見せる本リポジトリの目的に反する。Issue / PR 運用も分散する

### ローカル DB / 認証について

- PostgreSQL + 実認証（GitHub OAuth 等）を最初から使う案は、ローカル動作確認フェーズには過剰と判断した。データ永続化が必要になった時点（Scaffolder 実運用・デプロイ）で別 ADR として判断する
- guest 認証は Backstage が明示的に「ローカル開発用」と位置づけるもので、本番導入時には必ず置き換える（`auth` 変更は CONTRIBUTING.md の厳密運用対象）

## 採択理由

- 既存の運用基盤（CI・lint・commitlint）を壊さずに Backstage 本体を追加できる、最も影響範囲の小さい配置である
- scaffold デフォルト構成の採用により、Backstage 本体のアップグレード追従（`backstage-cli versions:bump`）との差分を最小化できる

## 影響

- Backstage 関連の作業はすべて `backstage/` 配下で行う（`yarn install` / `yarn start` / `yarn test`）
- ルートの `.markdownlint-cli2.jsonc` は `backstage/**` を lint 対象から除外する（生成コードはドキュメント正本ではない）
- Backstage 用の CI は `backstage/**` を working-directory とする job として追加する（別 Issue）
- 本番デプロイ時には DB（PostgreSQL 等）と認証方式を別 ADR で再判断する

## 関連

- [ADR 0001](./0001-adopt-backstage-for-idp-portfolio.md) — Backstage 採用の判断
- Issue [#14](https://github.com/kmryst/idp-golden-path/issues/14)
