# Architecture Decision Records

このディレクトリは、`idp-golden-path` の重要な設計判断を ADR（Architecture Decision Record）として残す場所です。

既存の設計文書は現在の正本として維持し、ADR は「なぜその判断にしたか」を後から追跡するための履歴として扱います。

## 番号付け

- ファイル名は `NNNN-kebab-case-title.md` とする
- `NNNN` は 4 桁の連番とし、一度使った番号は再利用しない
- 番号は ADR ファイルを追加する PR の時点で、`docs/adr/` 配下の最大番号 + 1 として確定する。Issue / ブランチの段階では番号を予約しない
- supersede する場合も古い ADR は削除せず、新しい ADR から参照する

## 形式

各 ADR は少なくとも次の項目を含めます。

- `ステータス`
- `日付`
- `決定内容`
- `背景`
- `検討した選択肢`
- `採択理由`
- `影響`
- `関連`

### ステータスの語彙

- `Proposed` — 提案中。まだ採択されていない
- `Accepted` — 採択済み。現在有効な判断
- `Superseded` — 後続の ADR に置き換えられた（置き換え先 ADR を `関連` から参照する）
- `Deprecated` — 廃止。置き換え先はないが、もう採用しない

### 日付の扱い

`日付` は **ADR を記録した日**であり、元の判断が行われた時期とは限りません。

## 一覧

| ADR | ステータス | 決定 |
| --- | --- | --- |
| [0001](./0001-adopt-backstage-for-idp-portfolio.md) | Accepted | IDP ポートフォリオの基盤に Backstage を採用する |
| [0002](./0002-adopt-lightweight-and-strict-github-flow.md) | Accepted | 既存 2 リポジトリの軽運用 / 厳密運用 GitHub Flow モデルを踏襲する |
| [0003](./0003-backstage-app-layout-and-local-dev-baseline.md) | Accepted | Backstage アプリを `backstage/` に配置し、ローカル開発は guest 認証 + インメモリ SQLite を基準とする |
| [0004](./0004-catalog-registration-via-local-stub-locations.md) | Accepted | 既存リポジトリのカタログ登録は当面 `catalog/` 配下の file location スタブで行う |
| [0005](./0005-techdocs-local-generator.md) | Accepted | TechDocs はローカル builder + ホスト mkdocs（runIn local）で運用する |
| [0006](./0006-scaffolder-service-baseline-template.md) | Accepted | Scaffolder ゴールデンパスは「リポジトリ・ガバナンスベースライン」テンプレートとして提供する |
| [0007](./0007-scaffolder-github-app-authentication.md) | Accepted | Scaffolder の GitHub 連携は個人 PAT を継続し、GitHub App へは移行しない |
| [0008](./0008-ci-guardrails-as-reusable-workflows-with-tag-pinning.md) | Accepted | CI ガードレールを reusable workflows として提供し、タグ固定（`@v1`）で参照する |
| [0009](./0009-production-deployment-on-ecs-fargate.md) | Accepted | 本番デプロイは ECS Fargate + Aurora Serverless v2 + GitHub OAuth とし、検証時のみ apply する 3 層 state 分離で運用する |
