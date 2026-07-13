# AGENTS.md — idp-golden-path Codex 作業ルール

このファイルは Codex が `idp-golden-path` で作業する時の入口です。
共通運用ルールをこのファイルへ複製しすぎず、正本を参照して作業してください。

## このリポジトリの目的

Backstage をベースにした Internal Developer Platform (IDP) のポートフォリオ実装です。
サービス新規立ち上げ時のゴールデンパス（テンプレート・CI/CD・インフラ・ガードレールの一括提供）をセルフサービス化します。

## 役割分担

- `AGENTS.md`: Codex 向けの作業入口。このファイルを Codex の正本とする
- `CLAUDE.md`: Claude Code 向けの作業入口。Codex の正本にはしない
- `CONTRIBUTING.md`: Issue / Branch / Commit / PR / Label / 軽運用・厳密運用の共通正本
- `docs/operations/github-flow-guardrails.md`: GitHub フローの設計意図、未採用案、再検討条件
- `.github/labels.yml`: ラベル一覧の正本
- `docs/adr/README.md`: ADR の採番・形式・ステータス運用の正本
- `docs/operations/branch-protection.md`: main ブランチ保護設定の記録

内容が衝突する場合は、共通運用は `CONTRIBUTING.md` を優先し、設計意図は `docs/operations/github-flow-guardrails.md` を参照します。

## 作業開始前に読むもの

1. `CONTRIBUTING.md`
2. `docs/operations/github-flow-guardrails.md`
3. `README.md`
4. 対象 Issue がある場合は `gh issue view <issue番号>`
5. 変更対象ファイル

作業内容に応じて、次の正本も読む。

| 条件 | 読むファイル |
|---|---|
| Issue 起票 | `docs/issue-templates/feature_request.md` または `.github/ISSUE_TEMPLATE/feature_request.yml` |
| PR 作成 | `.github/pull_request_template.md` |
| ラベル判断 | `.github/labels.yml` |
| 技術選定・構成判断を変える | 該当領域の正本と `docs/adr/` の関連 ADR |
| `.github/workflows/**` を変える | `docs/operations/github-flow-guardrails.md` と `docs/operations/branch-protection.md` |
| scripts 配下の helper を使う・変える | `CONTRIBUTING.md` と対象スクリプト |

## GitHub 運用ヘルパー

Codex は GitHub 操作を手作業で再現せず、既存 helper を正規ルートとして使います。

| 操作 | 正規ヘルパー |
|---|---|
| Issue 作成 | `./scripts/github/create-issue-with-labels.sh` |
| PR 作成 | `./scripts/github/create-pr-with-labels.sh` |
| マージ後 cleanup | `./scripts/github/cleanup-merged-pr-branch.sh <PR番号>` |

Issue 作成と PR 作成は、実行前にユーザーへプランを提示して確認します。
Issue 本文には専用の運用区分欄を追加せず、起票前プランと PR 作成前プランで軽運用 / 厳密運用を判定します。

PR がマージされた後、次の Issue へ進む前に必ず `cleanup-merged-pr-branch.sh` を実行します。
このヘルパーは PR が `MERGED` であることを確認し、base branch を最新化してから作業ブランチを整理します。

## 開発フロー

Issue / PR 駆動開発を必ず守ります。
順序: Issue 確認 → ブランチ作成 → 実装前計画提示 → 実装 → 検証 → コミット前停止 → コミット → 作業ブランチ push → PR → merge → cleanup。

`main` ブランチへの direct push は禁止です。ユーザーから依頼があっても実行せず、必ず PR を経由します。

## Issue 着手

新しい Issue に着手する時は、最新の `main` から作業ブランチを切ります。

```bash
git switch main
git pull --ff-only origin main
git switch -c <issue番号>-<kebab-case要約>
```

未コミット変更がある場合は、勝手に stash / reset しません。変更内容を確認し、ユーザーの意図に沿って進めます。

## PR 作成前

PR 作成前プランには、少なくとも次を含めます。

- タイトル案
- 目的
- 変更内容
- 影響範囲
- `Closes/Fixes/Refs #<issue番号>`
- 推奨ラベル (`type / area / risk / cost`)
- 軽運用 / 厳密運用の判定と理由
- 厳密運用の場合、`ロールバック` が必須かどうか
- 使用ヘルパー: `./scripts/github/create-pr-with-labels.sh`

`--body-file` には `.github/pull_request_template.md` をそのまま渡さず、テンプレートを埋めたコピーを別ファイルとして作成して渡します。
テンプレートをそのまま渡すと、未記入のプレースホルダ本文の末尾に helper が追記する `Closes #<issue番号>` が重複した、壊れた PR になります。

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

helper は PR を通常 PR として作成します。draft PR にはしません。

## 設計文書の更新と設計判断の記録

実装によって仕様・構成・運用手順が変わった場合は、まず該当領域の正本を更新します。
実装時は、仕様・構成・運用手順に加えて、監視・アラート・runbook・CI/CD・セキュリティ・コスト・利用者向け手順への docs 影響を必ず確認します。
影響がある場合は、同じ PR で該当領域の正本を更新します。正本がない場合に限り、最小限の docs を新規作成します。
影響がない場合は、不要な docs を増やしません。

現在の仕様・構成・運用手順は、領域ごとに定められた正本に従います。
ADR はその正本を置き換えるものではなく、重要な設計判断の背景・採択理由・トレードオフ・再検討条件を記録するものです。

トレードオフを伴う設計判断は `docs/adr/` に ADR として記録します。書き方と運用ルールは `docs/adr/README.md` に従います。番号は ADR を追加する PR の時点で確定し、Issue / ブランチ段階では予約しません。ADR で判断が変わった場合は、影響する領域の正本も同じ PR で更新します。

## コミットメッセージ

コミットを作成する場合は、必ず `CONTRIBUTING.md` の Conventional Commits ルールに従います。
`wip`、`fix` のみ、`update files` のような曖昧なメッセージを使ってはいけません。

PR 作成前には、対象コミットと PR title が commitlint を通ることを確認します。

```bash
npm run commitlint -- --from origin/main --to HEAD --verbose
```

## ローカル検証

CI と同じチェックをローカルで実行できます。

```bash
npm ci
npm run lint:md
npm run commitlint -- --from origin/main --to HEAD --verbose
```

## 禁止事項

次は、ユーザーから明示された場合でも実行前に確認します。

- AWS リソースを作成・変更・削除する CLI 操作
- `terraform apply` / `terraform destroy`
- `terraform state rm`
- `git push --force`
- `main` ブランチへの direct push
- branch protection などリポジトリ設定の無断変更
- GitHub Issue / PR の無断作成・無断編集
- secret / credential 値の出力
- `.env` ファイルのコミット

## ユーザー確認が必要な操作

以下は必ず事前にプランを提示し、ユーザーの確認を得てから実行します。

| 操作 | 確認のタイミング |
|---|---|
| Issue 起票 | 本文・ラベル案とコマンドを提示してから |
| 実装着手 | 変更対象・変更内容・影響範囲を提示してから |
| コミット | コミット前サマリを提示して停止してから |
| 作業ブランチ push | コミット確認後に明示的な許可を得てから |
| PR 作成 | タイトル・本文・ラベル・コマンド案を提示してから |
| ブランチ削除 | cleanup コマンド案を提示してから |
| リポジトリ設定変更 | 変更内容と戻し方を提示してから |

## PR 必須ラベル

`.github/labels.yml` が正本です。

| ラベル | 要件 |
|---|---|
| `type:*` | ちょうど 1 つ |
| `area:*` | 1 つ以上（複数可） |
| `risk:*` | ちょうど 1 つ |
| `cost:*` | ちょうど 1 つ |

PR 本文には `Closes #<issue番号>` / `Fixes #<issue番号>` / `Refs #<issue番号>` のいずれかを必須で含めます。
