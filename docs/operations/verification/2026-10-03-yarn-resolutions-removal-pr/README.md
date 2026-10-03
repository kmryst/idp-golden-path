# 脆弱性以外の yarn resolutions の probe と撤去 PR の自動作成 検証記録 (2026-10-03)

Issue #291（ADR-0015）の受け入れ条件にある 4 ケースを、`workflow_dispatch` を `--ref` で検証ブランチに向けて実走させて確認した記録。
run はすべて `Dependency Audit`（`.github/workflows/dependency-audit.yml`）で、見るべき job は
`Yarn Resolutions Inventory`（probe）と `Yarn Resolutions Removal PR`（撤去 PR 作成）の 2 つ。

> [!NOTE]
> 全 run で `Dependency Audit` / `npm Dependency Audit (root / skeleton)` job は失敗している。
> これは 2026-10-03 時点で main に残る `braces` / `fast-uri` / `undici` の High advisory によるもので
> （同日の Dependabot PR でも同じ失敗）、本 Issue の変更とは無関係。run 全体の色ではなく上記 2 job の結論で判定した。

## ブランチ

| ブランチ | 用途 |
| --- | --- |
| `291-yarn-resolutions-probe-and-removal-pr` | 実装（main 向け PR の head） |
| `291-verify-removal-pr` | 検証用。実装ブランチの commit `b786a80` から切り、ケース 2〜4 のための一時的な変更だけを積む。main にはマージしない |
| `dependency-bot/yarn-resolutions-removal` | GitHub App が作る撤去 PR の head（ブランチ名固定） |

## ケース 1: 外せない状態（現在の `@yarnpkg/core/got`）

実装ブランチの台帳そのまま（`probe.up = ["@backstage/cli"]`、`tracking = berry#7281`）。

| 項目 | 値 |
| --- | --- |
| run | [37107093481](https://github.com/kmryst/idp-golden-path/actions/runs/37107093481)（ref `291-yarn-resolutions-probe-and-removal-pr` @ `b786a80`） |
| probe の結果 | `probe @yarnpkg/core/got: yarn up -R @backstage/cli --mode=update-lockfile exited 1` → `still needed` |
| `Yarn Resolutions Inventory` | success（緑） |
| `Yarn Resolutions Removal PR` | skipped（`removal` 出力が `false`） |
| 撤去 PR | 作られていない |

対照（行を残した実行）は exit 0 で通っているため、ENOENT は上流（`@yarnpkg/core` 4.9.2 の `got` の patch 参照）が未修正であることを示す。

## ケース 2: 外せる状態を意図的に作る → 撤去 PR の作成と冪等性

検証ブランチの commit `7e68278` で、`backstage/package.json` に既存の range と同じ右辺の no-op resolutions
`"prettier@npm:^3.9.6": "^3.9.6"` を足し、台帳に `probe.up = ["prettier"]` で登録した。
右辺が既存の range と同じなので lockfile は変わらず、`yarn up -R prettier` は必ず通る（= 解除可能）。

| 項目 | 1 回目 | 2 回目（再実行） |
| --- | --- | --- |
| run | [37107229950](https://github.com/kmryst/idp-golden-path/actions/runs/37107229950) | [37107360739](https://github.com/kmryst/idp-golden-path/actions/runs/37107360739) |
| probe の結果 | `prettier@npm:^3.9.6` → `removable`、`@yarnpkg/core/got` → `still needed` | 同じ |
| `Yarn Resolutions Inventory` | success、artifact `yarn-resolutions-removal` を upload | 同じ |
| `Yarn Resolutions Removal PR` | success、`pull-request-operation = created` | success、`A pull request already exists`、`pull-request-operation = none` |
| 撤去 PR | [#292](https://github.com/kmryst/idp-golden-path/pull/292)（base `291-verify-removal-pr`、author `kmryst-dependency-bot[bot]`） | #292 のまま。重複 PR なし |

PR #292 の内容:

- タイトル / commit: `chore(deps): 不要になった yarn resolutions を撤去する`
- 差分: `backstage/package.json` +1 -2（`prettier@npm:^3.9.6` の行だけ削除）、`scripts/ci/yarn-resolutions-non-security.json` +0 -10（対応エントリの削除）。`backstage/yarn.lock` は差分なし（no-op resolutions のため）
- ラベル: `type:chore` / `area:backstage` / `area:ci-cd` / `risk:low` / `cost:none`（App のトークン = Pull requests: write で付与できた）
- 本文末尾: `Refs #291`

2 回目の run では差分が 1 回目と同一だったため branch / PR は変更されず `none` になった。
ケース 4 の run（下記）では base が進んだため `Updated branch` → `Updated pull request #292` → `pull-request-operation = updated` となり、
「再実行しても PR は重複せず、既存の PR が更新される」を両方のパターンで確認した。

## ケース 3: 故障を注入する（到達できない registry）

検証ブランチの commit `3e11b9a` で、`Check yarn resolutions inventory (stale)` step に
`YARN_NPM_REGISTRY_SERVER: https://registry.invalid` を注入した。

| 項目 | 値 |
| --- | --- |
| run | [37107421095](https://github.com/kmryst/idp-golden-path/actions/runs/37107421095) |
| `Yarn Resolutions Inventory` | failure（赤）。`::error::yarn install --mode=update-lockfile failed with status 1: ...` |
| `Yarn Resolutions Removal PR` | skipped（`needs` の暗黙の `success()`） |
| 撤去 PR | 作られていない（#292 も更新されていない） |

この注入は job 全体の registry を不通にするため、脆弱性対応の台帳の stale 判定（`yarn install --mode=update-lockfile`）で先に落ちた。
probe 固有の機構検査（対照の実行の失敗、`probe.up` が `yarn.lock` に無い）は、ローカルで次を確認した。

- `probe.up = ["no-such-package-abcxyz-291"]` にすると、`yarn up -R` 自体は exit 0 で通ってしまう（誤報の元）。
  機構検査が `::error::@yarnpkg/core/got.probe.up names no-such-package-abcxyz-291, which is not an npm dependency in backstage/yarn.lock; yarn up -R would match nothing and pass vacuously` で exit 1 にする
- 対照の実行が失敗した場合の分岐（`classifyProbe`）はユニットテストで確認（`node --test scripts/ci/yarn-resolutions-audit.test.mjs`、59 件 pass）

なお run 37107421095 のエラー文は Yarn のスタックトレース末尾（バンドル済みソース）になっていて原因が読めなかったため、
実装ブランチで `YN0001` などの報告行を抜き出す（`summarizeYarnFailure`）ように直した。
直した後のローカル実測: `::error::yarn install --mode=update-lockfile failed with status 1: ➤ YN0000: · Yarn 4.13.0 | ➤ YN0000: ┌ Resolution step | ➤ YN0001: │ RequestError: getaddrinfo ENOTFOUND registry.invalid | ...`

## ケース 4: 自動作成された撤去 PR 上で必須チェックが起動する

required status checks（PR Policy Check / Commitlint / Markdown Lint / Gitleaks Secret Scan）のワークフローは
`pull_request: branches: [main]` で絞られているため、base が検証ブランチの #292 では起動しない（ケース 2 の時点で check 0 件を確認）。
main 向けの PR は作らない制約のもとで確認するため、検証ブランチの commit `ec2bac4` で 4 ワークフローの `branches:` に
`291-verify-removal-pr` を一時的に追加し（ケース 3 の注入は `ba62e57` で revert）、ワークフローを再実行して #292 の head を進めた。

| 項目 | 値 |
| --- | --- |
| run（撤去 PR の更新） | [37107497389](https://github.com/kmryst/idp-golden-path/actions/runs/37107497389) → `Updated pull request #292`、`pull-request-operation = updated`、head `c506d60` |
| #292 の check run（head `c506d60`） | PR Policy Check [37107544926](https://github.com/kmryst/idp-golden-path/actions/runs/37107544926) / [37107545007](https://github.com/kmryst/idp-golden-path/actions/runs/37107545007) success、Commitlint [37107544932](https://github.com/kmryst/idp-golden-path/actions/runs/37107544932) / [37107544958](https://github.com/kmryst/idp-golden-path/actions/runs/37107544958) success、Markdown Lint [37107545203](https://github.com/kmryst/idp-golden-path/actions/runs/37107545203) success、Gitleaks Secret Scan [37107545034](https://github.com/kmryst/idp-golden-path/actions/runs/37107545034) success |

PR Policy Check と Commitlint が 2 回ずつあるのは、`synchronize`（branch の更新）と `edited`（本文の更新）の 2 イベントで起動したため。
GitHub App のトークンで作った PR で `pull_request` イベントが発火し、ラベル・`Refs #291`・Conventional Commits のタイトルで
4 つの必須チェックがすべて通ることを確認した。

## 追記: App トークンの発行を `app-id` から `client-id` に切り替えた再検証

ケース 1〜4 の run は `app-id: ${{ vars.DEPENDENCY_BOT_APP_ID }}` で実行しており、`Yarn Resolutions Removal PR` job に
`##[warning]Input 'app-id' has been deprecated with message: Use 'client-id' instead.` の注釈が出ていた。
variable `DEPENDENCY_BOT_CLIENT_ID` を登録した上で `client-id: ${{ vars.DEPENDENCY_BOT_CLIENT_ID }}` に変え、
検証ブランチ（commit `41e8d39`）でケース 2 を再実行した。

| 項目 | 値 |
| --- | --- |
| run | [37108580075](https://github.com/kmryst/idp-golden-path/actions/runs/37108580075) |
| `Yarn Resolutions Removal PR` | success。トークン発行 → `Updated pull request #292`、`pull-request-operation = updated`（base が進んでいたため）、head `556ea59` |
| deprecation の注釈 | 消えた。job の annotation は runner image 移行の notice 1 件のみ |

`DEPENDENCY_BOT_APP_ID` は使われなくなったため、main へのマージ後に削除する。

## 確認できていないこと

- 対照の実行（行を残した `yarn up -R`）が失敗する経路を CI 上では踏んでいない（ユニットテストとローカルの `probe.up` 検査で代替）
- 実際に上流（berry#7281）が修正されたときの `@yarnpkg/core/got` の撤去 PR は、自然発生を待つ

## 後片付け

検証後に次を削除する: PR #292（close）、ブランチ `dependency-bot/yarn-resolutions-removal`、ブランチ `291-verify-removal-pr`。
