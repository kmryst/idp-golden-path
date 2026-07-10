# 0012. Backstage の auth provider 設定を環境別 config に分離する

## ステータス

Accepted

## 日付

2026-07-10

## 決定内容

Backstage の `auth.providers` は、共通の `backstage/app-config.yaml` ではなく、環境別 config に置く。

- ローカル開発: `backstage/app-config.development.yaml` に `auth.providers.guest` を定義する
- 本番: `backstage/app-config.production.yaml` に `auth.providers.github` を定義する
- `backstage/app-config.yaml` は共通 auth 設定のみを持ち、環境固有の provider を持たない
- `yarn start` は `app-config.yaml` + `app-config.development.yaml` を明示的に読み込む
- `app-config.local.yaml` が存在する場合は、ローカル個人 override として追加で読み込む
- CI で development / production の Backstage config を検証する

## 背景

これまでは `app-config.yaml` にローカル開発用の `auth.providers.guest` を置き、本番では `app-config.production.yaml` の `guest: null` で guest provider を無効化していた。

この `null` override は Backstage の config merge としては有効なパターンだが、VS Code / Cursor の YAML schema は `auth.providers.guest` を object として扱うため、`guest: null` に `Incorrect type` 警告を出す。警告を常態化させると、本物の config 不整合を見落としやすくなる。

また、本番で guest 認証を使わないという境界は、上書き削除よりも「本番 config には GitHub provider だけを書く」形の方が読み取りやすい。

## 検討した選択肢

### `guest: null` を維持する案

- 長所: Backstage upstream の create-app に近い構成を維持できる
- 長所: `yarn start` のデフォルト config 読み込みに手を入れずに済む
- 短所: エディタ上の schema 警告が残る
- 短所: production config に「本番では使わない guest provider」のキーが残り、意図をコメントで補う必要がある

### auth provider を環境別 config に分離する案（採択）

- 長所: 共通 config と環境固有 config の境界が明確になる
- 長所: production config から `guest: null` を消せるため、schema 警告が解消される
- 長所: 本番で許可する auth provider が `app-config.production.yaml` だけで読み取れる
- 短所: `--config` を明示するため、Backstage CLI の `app-config.local.yaml` 自動読み込みを補う必要がある
- 短所: Backstage upstream の scaffold 初期構成との差分が少し増える

### `app-config.local.yaml` に guest provider を置く案

- 長所: Backstage CLI の default loading と相性がよい
- 短所: `*.local.yaml` は gitignore 対象であり、ローカル開発に必須の設定を置くと再現性が落ちる

## 採択理由

このリポジトリでは、ローカル開発は guest 認証、本番は GitHub OAuth という境界を運用上の重要な前提としている。環境別 config に provider を分離すると、その境界が config の形から直接分かる。

`guest: null` 自体は壊れた設定ではないが、schema 警告を恒常的に許容するより、警告のない config と CI の config 検証を組み合わせる方が運用品質を保ちやすい。

## 影響

- `yarn start` は `app-config.yaml` と `app-config.development.yaml` を明示的に読む
- `app-config.local.yaml` が存在する場合は、従来どおり個人 override として読み込む
- 本番 Docker の起動 config は `app-config.yaml` + `app-config.production.yaml` のまま維持する
- Backstage CI は development / production config の `config:check` を実行する
- production config の `$file: rds-global-bundle.pem` は Docker build 時に取得するため、CI の config check では一時ファイルで存在だけを満たす

## 関連

- [ADR 0003](./0003-backstage-app-layout-and-local-dev-baseline.md) — ローカル開発は guest 認証 + インメモリ SQLite を基準とする
- [ADR 0009](./0009-production-deployment-on-ecs-fargate.md) — 本番は GitHub OAuth を使う
- Issue [#97](https://github.com/kmryst/idp-golden-path/issues/97)
