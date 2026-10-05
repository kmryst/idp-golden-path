# npm Dependency Audit 期限付き例外 検証記録 (2026-10-05)

Issue #300 / PR #301 で、本リポジトリ自身の `npm Dependency Audit (root)` / `npm Dependency Audit (skeleton)` に
期限付き例外（`scripts/ci/npm-audit-exceptions.json`）を適用した。その実地検証の記録。

## 前提

- `main`（e72034b）のルート / skeleton の `npm audit` は high 5 件。根本 advisory は braces の
  GHSA-vfj7-8cjw-p6xm（修正版なし）1 件だけで、micromatch / fast-glob / globby / markdownlint-cli2 は
  `via` 連鎖で braces を経由して報告されている
- runtime 依存（`--omit=dev`）の audit は両ディレクトリとも high 0 件
- 例外ファイルの登録内容: `GHSA-vfj7-8cjw-p6xm`、expires `2026-12-31`（2026-10-05 から 87 日、最大 90 日以内）、追跡 Issue #297

異常系は、PR ブランチから派生させた一時ブランチ（`main` にマージせず検証後に削除）で
例外ファイルだけを書き換え、`workflow_dispatch` を `--ref` で当該ブランチに向けて実行した。
比較用に同時刻の `main` でも `workflow_dispatch` を実行した。

## 結果

| ケース | ブランチ | run | `npm Dependency Audit (root)` | `npm Dependency Audit (skeleton)` |
| --- | --- | --- | --- | --- |
| 例外あり（PR） | `300-npm-audit-exceptions` | [37274563906](https://github.com/kmryst/idp-golden-path/actions/runs/37274563906) | success | success |
| 期限切れ（expires を 2026-10-04 に変更） | `300-verify-expired-npm-exception` | [37274579630](https://github.com/kmryst/idp-golden-path/actions/runs/37274579630) | failure | failure |
| 例外を削除（`[]`） | `300-verify-removed-npm-exception` | [37274582164](https://github.com/kmryst/idp-golden-path/actions/runs/37274582164) | failure | failure |
| 比較: 変更前の `main` | `main` | [37274590934](https://github.com/kmryst/idp-golden-path/actions/runs/37274590934) | failure | failure |

### 例外あり: 緑

Job Summary（root、実出力）:

```text
- Runtime dependencies: passed the unfiltered High / Critical gate
- Full dependency graph: passed
| GHSA-vfj7-8cjw-p6xm | high | braces, fast-glob, globby, markdownlint-cli2, micromatch | 2026-12-31 | [Issue](https://github.com/kmryst/idp-golden-path/issues/297) | allowed temporarily |
```

braces の GHSA 1 件の登録だけで、`via` 連鎖上の 4 パッケージも同じ finding として許可された
（依存パッケージを名前で登録していない）。skeleton も同じ出力。

### 期限切れ: 赤（fail closed）

両 job とも評価器が例外の適用前に停止した（実出力）:

```text
The gate failed closed before an exception could be applied.
- Error: npm-audit-exceptions[0].expires (2026-10-04) is before the current UTC date (2026-10-05)
```

`npm-audit-exceptions` はエラー文言上の名前で、reusable workflow input と評価器を共有しているため
yarn 側（リポジトリ内ファイルでも `yarn-audit-exceptions[0]` と出る）と同じ表記になる。

### 例外を削除: 赤（従来の素のゲート）

例外ファイルが `[]` のときは評価器を通らず、従来の `npm audit --audit-level=high` が実行され、
`5 high severity vulnerabilities` で exit 1 になった。変更前の `main` と同じ挙動。

### yarn の `Dependency Audit` は不変

PR の run と `main` の run で、yarn の `Dependency Audit` はどちらも `Audit gate (fail on high or critical) [yarn]`
で failure になり、検出された advisory ID（28 件）は完全に一致した（この赤は PR #299 で対応中の既存の検出で、
本 PR の変更とは無関係）。`Test audit policy evaluators` step（本 PR で追加したテストを含む）は success。
`dependency-audit` job の step 定義は本 PR で変更していない（コメントのみ）。

## 後片付け

- 一時ブランチ `300-verify-expired-npm-exception` / `300-verify-removed-npm-exception` は検証後に削除した
