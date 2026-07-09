# CI 品質ゲート トラブルシューティング

PR の required status check（`PR Policy Check` / `Commitlint` / `Markdown Lint` / `Gitleaks Secret Scan`）まわりで、
実装バグではなく **GitHub Actions の concurrency 挙動**が原因でマージがブロックされた事象と、その恒久対応を記録する。

これらの check は [ADR 0008](../adr/0008-ci-guardrails-as-reusable-workflows-with-tag-pinning.md) の
reusable workflow として本リポジトリを正本にし、Scaffolder skeleton・terraform-hannibal・ticket-c2c-platform が
`@v1` 参照で共有する。したがって本ドキュメントの事象と対応は 3 リポジトリ + skeleton に横断で効く。

## 事象: ラベル連続付与で `PR Policy Check` が一時的に `expected` 扱いになる

### 症状

PR 作成 helper（`scripts/github/create-pr-with-labels.sh`）は type / area / risk / cost の必須ラベルを
連続して付与する。このとき `pull_request` の `labeled` イベントが短時間に連発し、
required status check の `PR Policy Check` が一時的に `expected`（未充足）扱いになってマージがブロックされる。

### 根本原因

GitHub Actions の `concurrency` はデフォルトで `queue: single` として振る舞う。
`queue: single` は **同一 concurrency group の pending run を 1 つしか保持しない**。
`labeled` / `unlabeled` が連発すると、先に queue に入っていた古い pending run が新しい run の到着で cancel され、
その run に対応する check run が `expected` のまま解決されず、required status check 判定が未充足になる。

これは先行課題（実行中 run の cancel が CANCELLED check run を commit に残し required check をブロックする問題）と
同じく、「concurrency による run の cancel が required check 判定に混入する」という GitHub Actions の一般的な挙動である。

### 対応: `concurrency` に `queue: max` を追加（Issue #87 / PR #88）

reusable workflow 正本 `.github/workflows/pr-policy-check.yml` の `concurrency` に `queue: max` を追加した。

```yaml
concurrency:
  group: pr-policy-check-${{ github.event.pull_request.number }}
  cancel-in-progress: false
  queue: max
```

- `queue: max` は pending run を cancel せず **FIFO で順次実行**する。古い pending run が捨てられなくなる。
- `queue: max` は `cancel-in-progress: false` と**のみ**併用できる。`cancel-in-progress: true` との併用は
  workflow の validation error になるため、heavy CI を新 SHA で上書きしたい `backstage-ci.yml` 等には付けない。
- ラベル判定は job 内で `gh pr view` により最新ラベルを都度再取得しているため、古い payload の run が
  後から実行されても判定結果は変わらない（順次実行による遅延はあっても誤判定は起きない）。

reusable workflow 構成のため、正本の `pr-policy-check.yml` に加えて
`backstage/templates/service-baseline/skeleton/.github/workflows/pr-policy-check.yml`（caller テンプレート）にも
同じ設定を反映した。skeleton から生成されるリポジトリは caller 経由で `@v1` を参照するため、
caller 側 concurrency にも `queue: max` が必要になる。

### 検証結果

idp-golden-path / terraform-hannibal / ticket-c2c-platform の同一構成 3 リポジトリで、
実 PR に対しラベルを **11 回連続で付け外し**し、`gh run list` で run の終了状態を確認した。

| 指標 | 結果 |
| --- | --- |
| 対象リポジトリ | 3（idp-golden-path / terraform-hannibal / ticket-c2c-platform） |
| 集計 run 数 | 合計 47 |
| CANCELLED | 0 |
| required check の恒久ブロック | なし（すべて FIFO で SUCCESS に解決） |

## 関連

- [ADR 0008. CI ガードレールを reusable workflows として提供し、タグ固定（`@v1`）で参照する](../adr/0008-ci-guardrails-as-reusable-workflows-with-tag-pinning.md)
- Issue #87 / PR #88（`queue: max` 追加。正本 + skeleton caller の 2 ファイル）
- [GitHub Docs: Control the concurrency of workflows and jobs](https://docs.github.com/en/actions/using-jobs/using-concurrency)
