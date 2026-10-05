# npm overrides の撤去 PR 自動作成 検証記録 (2026-10-05)

Issue #310（ADR-0016）の分割 2（npm overrides の撤去 PR 化）を、`workflow_dispatch` を `--ref` で検証ブランチに向けて
実走させて確認した記録。run はすべて `Dependency Audit`（`.github/workflows/dependency-audit.yml`）で、見るべき job は
`npm Overrides Inventory`（棚卸し）と `npm Overrides Removal PR`（撤去 PR 作成）の 2 つ。

> [!NOTE]
> 全 run で `Dependency Audit` job（`backstage/` の yarn 監査ゲート）は失敗している。
> これは 2026-10-05 時点で main に残る High advisory によるもので（main の schedule 実行でも同じ失敗。#299 で対応中）、
> 本 Issue の変更とは無関係。run 全体の色ではなく上記 2 job の結論で判定した。

## ブランチ

| ブランチ | 用途 |
| --- | --- |
| `310-npm-overrides-removal-pr` | 実装（main 向け PR の head）。commit `a0dce84` |
| `310-verify-npm-overrides-removal-pr` | 検証用。実装ブランチから切り、ケースごとの一時的な変更だけを積んだ（下表）。main にはマージしない。検証後に削除した |
| `dependency-bot/npm-overrides-removal` | GitHub App が作る撤去 PR の head（ブランチ名固定）。検証後に削除した |

台帳は main では空（`[]`）なので、検証ブランチで「外せる」状態を作った。

| commit | 内容 |
| --- | --- |
| `e52a219` | ルートと skeleton の `package.json` に `"overrides": { "argparse": "2.0.1" }`（ロック済みの版と同じ右辺 = no-op）を足し、台帳に存在しない GHSA（`GHSA-0000-0000-0000`）で登録。advisory が再出現しないため必ず stale になる |
| `21fc54c` | 右辺を `2.0.0` に変え、両方の `package-lock.json` を更新（`argparse` が 2.0.0 にロックされる）。撤去すると lock が 2.0.1 に戻る = lockfile が変わる |
| `b6a301e` | `npm Overrides Inventory` の stale step に `npm_config_registry: https://registry.invalid` を注入 |

## ケース 1: 外せる状態 → 撤去 PR の作成と冪等性（`e52a219`）

| 項目 | 1 回目 | 2 回目（再実行） |
| --- | --- | --- |
| run | [37288899110](https://github.com/kmryst/idp-golden-path/actions/runs/37288899110) | [37289001520](https://github.com/kmryst/idp-golden-path/actions/runs/37289001520) |
| `npm Overrides Inventory` | success（緑）。`Result: removable: removal pull request will be created`、`lockfile changes: false` | 同じ |
| `npm Overrides Removal PR` | success、PR 作成 | success、`A pull request already exists`、`pull-request-operation = none` |
| 撤去 PR | [#314](https://github.com/kmryst/idp-golden-path/pull/314)（base は検証ブランチ、author `app/kmryst-dependency-bot`、Draft ではない） | #314 のまま。重複 PR なし |

PR #314 の内容:

- タイトル / commit: `chore(deps): 不要になった npm overrides を撤去する`
- 差分: ルートと skeleton の `package.json` から `overrides` キーごと削除（`argparse` だけだったため）、`scripts/ci/npm-overrides.json` を `[]` に戻す。`package-lock.json` は差分なし
- ラベル: `type:chore` / `area:ci-cd` / `area:golden-path` / `risk:low` / `cost:none`
- 本文末尾: `Refs #310`

## ケース 2: lockfile が変わる状態 → Draft（`21fc54c`）

| 項目 | 値 |
| --- | --- |
| run | [37289134180](https://github.com/kmryst/idp-golden-path/actions/runs/37289134180) |
| `npm Overrides Inventory` | success（緑）。`lockfile changes: true` |
| `npm Overrides Removal PR` | success、`pull-request-operation = updated` |
| 撤去 PR | #314 が更新され、**Draft に変わった**（`draft: always-true`）。本文の冒頭に「`.` と skeleton で `npm install --package-lock-only --ignore-scripts` を実行して `package-lock.json` をコミットしてから Ready for review にする」が出た |

## ケース 3: 機構の故障（到達できない registry、`b6a301e`）

| 項目 | 値 |
| --- | --- |
| run | [37289318534](https://github.com/kmryst/idp-golden-path/actions/runs/37289318534) |
| `npm Overrides Inventory` | failure（赤）。`npm install --package-lock-only failed for . with status 1: npm error code ENOTFOUND` |
| `npm Overrides Removal PR` | skipped（`needs` の暗黙の `success()`） |
| 撤去 PR | #314 は更新されていない（`updatedAt` が run の前後で同じ） |

## ユニットテストで確認したこと

`node --test scripts/ci/npm-overrides-audit.test.mjs`（57 件 pass）で、次を確認している。

- 全ての適用先で stale のエントリだけを撤去対象にし、一部の適用先でだけ stale のエントリは partial として赤にすること
- `removal.json` の改ざん（余分なキー、パッケージ名以外の pattern、重複、型の違い）と、artifact に `removal.json` 以外のファイルがある場合、台帳に無い pattern を指す場合の拒否（作業ツリーを書き換えないこと）
- 撤去で `overrides` が空になったらキーごと消えること、PR 本文と Draft の要否が `lockfileChanges` に従うこと
- 撤去後に「外す前に無かった High / Critical」だけを新規として数えること（既存の例外付き advisory は数えない）

## 後片付け

- PR #314 を close し、`dependency-bot/npm-overrides-removal` ブランチを削除した
- 検証ブランチ `310-verify-npm-overrides-removal-pr` を削除した
- 検証用の Issue は作っていない（npm overrides の台帳は追跡 Issue を持たない）
