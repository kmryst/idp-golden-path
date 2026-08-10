# CI 品質ゲート トラブルシューティング

CI 品質ゲートまわりで、実装バグではなく **GitHub Actions / `gh` CLI 側の挙動**が原因で
マージがブロックされたり調査が進まなくなったりした事象と、その対応を記録する。
reusable workflow 構成に固有の運用ハマりどころを集約する場所として使う。

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

## 事象: caller 経由の run では `gh run view --log` がログ本文を返さない

### 症状

消費側リポジトリ（terraform-hannibal / ticket-c2c-platform）の run に対して
`gh run view <run-id> --log` を実行しても、**何も出力されない**（終了コードは 0 で、標準出力が空）。
`--log-failed` も同様に空になる。失敗した run の原因が分からず、エラーメッセージが読めない。

本リポジトリ自身の run（dual-trigger の `pull_request` 側）では同じコマンドが正常にログを返すため、
コマンドの使い方の誤りだと気付きにくい。

### 根本原因

`gh run view --log` は run 単位のログ zip をダウンロードして整形するが、
caller 経由の run に対してはこの取得が空になる（下記の実測）。
何が空を返しているのか（GitHub API 側がログを持たないのか、`gh` が caller の run にログ zip を
見つけられないのか）までは切り分けていない。**運用上必要なのは代替手段であり、切り分けは行っていない。**

一方で、annotation は caller の run に紐づく check run から取得できる。
検査系ジョブの検出内容は `::error::` で annotation に載るため、ログ zip が空でも内容は読める。

### 対応: ANNOTATIONS を読む

reusable workflow の検査系ジョブ（`Toolchain Version Check` 等）は、
検出内容を `::error::` で出力して GitHub の annotation に載せている。
annotation は run のサマリから取得できるため、ログ zip が空でも内容を読める。

```bash
# 1. run のサマリを見る。末尾の ANNOTATIONS 節に検出内容がすべて出る
gh run view <run-id> -R kmryst/<repo>

# 2. 機械処理したい場合は job ID を取って annotations API を叩く
#    job ID は上の出力の "JOBS" 節に (ID nnnnnnnn) として出ている
gh api repos/kmryst/<repo>/check-runs/<job-id>/annotations --jq '.[].message'
```

`gh run view <run-id>` の JOBS 節には step 単位の成否も出るため、
どの step で落ちたかの特定にはこれで足りる。ログ本文が必要な場合は Web UI を開く。

### 検証結果

2026-08-10 に Toolchain Version Check のネガティブテストを実施した際、3 リポジトリで実測した。

| 対象 run | `--log` の出力行数 |
| --- | --- |
| idp-golden-path 31399408516（本リポジトリ自身、caller なし） | 330 |
| terraform-hannibal 31398931474（caller 経由） | 0 |

caller 経由の run でも `gh run view <run-id>` の ANNOTATIONS 節、および
`gh api repos/kmryst/terraform-hannibal/check-runs/93490341767/annotations` は
検出メッセージを完全に返した。詳細は
[Toolchain Version Check ネガティブテスト 検証記録](./verification/2026-08-10-toolchain-version-check/README.md) を参照。

## 関連

- [ADR 0008. CI ガードレールを reusable workflows として提供し、タグ固定（`@v1`）で参照する](../adr/0008-ci-guardrails-as-reusable-workflows-with-tag-pinning.md)
- Issue #87 / PR #88（`queue: max` 追加。正本 + skeleton caller の 2 ファイル）
- Issue #179（caller 経由のログ取得手順の記録）
- [Toolchain Version Check ネガティブテスト 検証記録 2026-08-10](./verification/2026-08-10-toolchain-version-check/README.md)
- [GitHub Docs: Control the concurrency of workflows and jobs](https://docs.github.com/en/actions/using-jobs/using-concurrency)
