# CLAUDE.md — idp-golden-path Claude Code 作業ルール

このファイルは Claude Code が `idp-golden-path` で作業を開始する前に読む入口です。
一般論ではなく、このリポジトリ固有のルールに従って作業してください。

## このリポジトリの目的

Backstage をベースにした Internal Developer Platform (IDP) のポートフォリオ実装です。
サービス新規立ち上げ時の「ゴールデンパス」（テンプレート・CI/CD・インフラ・ガードレールの一括提供）をセルフサービス化します。

[terraform-hannibal](https://github.com/kmryst/terraform-hannibal) /
[ticket-c2c-platform](https://github.com/kmryst/ticket-c2c-platform) の運用で手作業になっていた
ADR 運用・production-readiness チェック・CI ガードレールの再発明を、プラットフォームとして抽象化することを目指します。

GitHub 運用は Org を作らず、個人アカウント（kmryst）配下で行います
（GitHub App 移行を見送った経緯は [ADR 0007](./docs/adr/0007-scaffolder-github-app-authentication.md) 参照）。

## 技術スタック方針

- プラットフォーム本体: Backstage（Node.js / TypeScript）
- Software Catalog / Scaffolder / TechDocs を中核機能として扱う
- インフラは AWS + Terraform を想定（実装着手時に ADR で確定する）
- 運用基盤（運用ルール・CI・ADR）に続き、Backstage アプリ本体（`backstage/`）と
  ゴールデンパステンプレート（`backstage/templates/service-baseline/`）を実装済み。
  デプロイ先は未確定で、現段階はローカル開発のみ（ADR 0003 参照）

構成や技術選定を変える判断は、必ず ADR（`docs/adr/`）に記録する。

## 位置づけ

- `CLAUDE.md`: Claude Code 向けの作業入口。このファイルを Claude Code の正本とする。
- `CONTRIBUTING.md`: Issue / Branch / Commit / PR / Label / 軽運用・厳密運用の共通正本。
- `.github/labels.yml`: ラベル一覧の正本。
- `docs/adr/`: 設計判断（ADR）の正本。運用ルールは `docs/adr/README.md`。
- `docs/operations/branch-protection.md`: main ブランチ保護設定の記録。

内容が衝突する場合は、共通運用は `CONTRIBUTING.md` を優先する。

## 作業開始前に必ず読むファイル

1. `CONTRIBUTING.md`
2. `README.md`
3. 対象 Issue がある場合は `gh issue view <issue番号>`
4. 変更対象ファイル

## 作業内容別に追加で読むファイル

| 条件 | 読むファイル |
| --- | --- |
| Issue 起票 | `docs/issue-templates/feature_request.md` / `.github/ISSUE_TEMPLATE/feature_request.yml` |
| PR 作成 | `.github/pull_request_template.md` |
| ラベル判断 | `.github/labels.yml` |
| 技術選定・構成判断を変える | `docs/adr/` の関連 ADR |
| `.github/workflows/**` を変える | `docs/operations/branch-protection.md`（required status checks との整合） |
| scripts 配下の helper を使う・変える | `CONTRIBUTING.md` と対象スクリプト |

## 開発フロー

Issue / PR 駆動開発を必ず守る。
順序: Issue 確認 → ブランチ作成 → 実装前計画提示 → 実装 → 検証 → コミット前停止 → コミット → push → PR → merge → cleanup。

### Issue 作成

Issue は起票前にプランを提示してユーザーに確認してもらう。

Issue 作成前プランには、タイトル案、目的、対象、受け入れ条件、推奨ラベル、
軽運用 / 厳密運用の判定と理由、使用ヘルパーを明示する。

```bash
./scripts/github/create-issue-with-labels.sh \
  --title "短い要約" \
  --body-file docs/issue-templates/feature_request.md \
  --type type:feature \
  --area area:backstage \
  --risk risk:low \
  --cost cost:none
```

### Issue 着手

新しい Issue に着手する時は、最新の `main` から作業ブランチを切る。

```bash
git switch main
git pull --ff-only origin main
git switch -c <issue番号>-<kebab-case要約>
```

未コミット変更がある場合は、勝手に stash / reset しない。変更内容を確認し、ユーザーの意図に沿って進める。

### PR 作成

PR は作成前にプランを提示してユーザーに確認してもらう。

PR 作成前プランには、タイトル案、目的、変更内容、影響範囲、`Closes/Fixes/Refs #<issue番号>`、推奨ラベル、
軽運用 / 厳密運用の判定と理由、厳密運用の場合は `ロールバック` が必須かどうか、使用ヘルパーを明示する。

`--body-file` には `.github/pull_request_template.md` をそのまま渡さず、テンプレートを埋めたコピーを別ファイルとして作成して渡す。
テンプレートをそのまま渡すと、未記入のプレースホルダ本文の末尾に helper が追記する `Closes #<issue番号>` が重複した壊れた PR になる。

```bash
./scripts/github/create-pr-with-labels.sh \
  --title "feat: add scaffolder template for nodejs service" \
  --body-file /path/to/filled-pr-body.md \
  --issue <issue番号> \
  --type type:feature \
  --area area:golden-path \
  --risk risk:low \
  --cost cost:none \
  --base main
```

helper は PR を draft で作成する。PR 内容を確認したら、ready にしてレビュー・マージ可能な状態にする。

```bash
gh pr ready <PR番号>
```

### マージ後 cleanup

PR がマージされた後、次の Issue へ進む前に原則として実行する。

```bash
./scripts/github/cleanup-merged-pr-branch.sh <PR番号>
```

## 設計文書の更新と設計判断の記録

実装によって設計・運用・構成が変わった場合は、まず `docs/` 配下の該当ドキュメントを更新する。

トレードオフを伴う設計判断は `docs/adr/` に ADR として記録する。
書き方と運用ルールは `docs/adr/README.md` に従う。番号は ADR を追加する PR の時点で確定し、Issue / ブランチ段階では予約しない。
ADR で判断が変わったら、対応する正本ドキュメントも同じ PR で更新する。

## コミットメッセージ

コミットを作成する場合は、必ず `CONTRIBUTING.md` の Conventional Commits ルールに従う。
`wip`、`fix` のみ、`update files` のような曖昧なメッセージを使わない。

PR 作成前には、対象コミットと PR title が commitlint を通ることを確認する。

```bash
npx commitlint --from origin/main --to HEAD --verbose
```

## ローカル検証

CI と同じチェックをローカルで実行できる。

```bash
npm ci
npm run lint:md      # Markdown lint
npm run commitlint -- --from origin/main --to HEAD --verbose
```

## 禁止事項

ユーザーから明示的に指示された場合でも、実行前に必ず確認する。

- AWS リソースを作成・変更・削除する CLI 操作
- `terraform apply` / `terraform destroy`
- `terraform state rm`
- `git push --force` / `main` ブランチへの direct push
- branch protection などリポジトリ設定の無断変更
- GitHub Issue / PR の無断作成・無断編集
- secret / credential 値の出力
- `.env` ファイルのコミット

## ユーザー確認が必要な操作

以下は必ず事前にプランを提示し、ユーザーの確認を得てから実行する。

| 操作 | 確認のタイミング |
| --- | --- |
| Issue 起票 | 本文・ラベル案とコマンドを提示してから |
| 実装着手 | 変更対象・変更内容・影響範囲を提示してから |
| コミット | コミット前サマリを提示して停止してから |
| git push | コミット確認後に明示的な許可を得てから |
| PR 作成 | タイトル・本文・ラベル・コマンド案を提示してから |
| ブランチ削除 | cleanup コマンド案を提示してから |
| リポジトリ設定変更 | 変更内容と戻し方を提示してから |

## PR 必須ラベル（4種類）

| ラベル | 要件 |
| --- | --- |
| `type:*` | ちょうど 1 つ |
| `area:*` | 1 つ以上（複数可） |
| `risk:*` | ちょうど 1 つ |
| `cost:*` | ちょうど 1 つ |

PR 本文には `Closes #<issue番号>` / `Fixes #<issue番号>` / `Refs #<issue番号>` のいずれかを必須で含める。
`create-pr-with-labels.sh` は `Closes #<issue番号>` を自動で追記する。

## ラベル一覧

`.github/labels.yml` が正本。

| 種別 | 値 |
| --- | --- |
| type | `type:feature` / `type:bug` / `type:docs` / `type:infra` / `type:chore` / `type:refactor` / `type:test` |
| area | `area:backstage` / `area:catalog` / `area:golden-path` / `area:infra` / `area:ci-cd` / `area:docs` / `area:architecture` |
| risk | `risk:low` / `risk:medium` / `risk:high` |
| cost | `cost:none` / `cost:small` / `cost:medium` / `cost:large` |
