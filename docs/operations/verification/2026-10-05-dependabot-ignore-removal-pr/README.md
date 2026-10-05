# Dependabot ignore の撤去 PR 自動作成 検証記録 (2026-10-05)

Issue #310（ADR-0016）の分割 1（Dependabot ignore の撤去 PR 化）を、`workflow_dispatch` を `--ref` で
実装ブランチと検証ブランチに向けて実走させて確認した記録。
run はすべて `Dependency Unblock Check`（`.github/workflows/dependency-unblock-check.yml`）で、見るべき job は
`Dependency Unblock Check`（probe）と `Dependabot Ignore Removal PR`（撤去 PR 作成）の 2 つ。

## ブランチと Issue

| 名前 | 用途 |
| --- | --- |
| `310-dependabot-ignore-removal-pr` | 実装（main 向け PR の head）。commit `480fbdd` |
| `310-verify-ignore-removal-pr` | 検証用。実装ブランチから切り、ダミーの ignore と台帳エントリだけを足した（commit `5e52968`）。main にはマージしない。検証後に削除した |
| `dependency-bot/dependabot-ignore-removal` | GitHub App が作る撤去 PR の head（ブランチ名固定）。検証後に削除した |
| Issue #311 | 検証用の追跡 Issue（`dependabot-ignore` ラベル付き）。検証後に close した |

検証ブランチのダミーは、`/backstage` の ignore `idp-verify-310-dummy`（7 項目コメントの `追跡: Issue #311`）と、
台帳の `probe: true` / `steps: ["true"]` のエントリである。`steps` が必ず通るため `UNBLOCKED` になる。
既存の `typescript` エントリは残したので、同じ run で「1 件が UNBLOCKED、1 件が still blocked」を再現している。

## ケース 1: 解除できない状態（実装ブランチの台帳そのまま）

| 項目 | 値 |
| --- | --- |
| run | [37284789358](https://github.com/kmryst/idp-golden-path/actions/runs/37284789358)（ref `310-dependabot-ignore-removal-pr`） |
| probe の結果 | `typescript@7` → `still blocked`（`yarn lint:all` が exit 1） |
| `Dependency Unblock Check` | success（緑）。`## OK: still blocked（probe 1 件、全て想定どおり失敗）` |
| `Dependabot Ignore Removal PR` | skipped（`removal` 出力が `false`） |

Issue #305 の新しい `steps`（`yarn up typescript@7` → `yarn up -R rollup-plugin-dts` → `yarn add -D @typescript/typescript6@^6` →
`yarn lint:all` → `yarn build:all`）が CI 上で 1〜3 を通過し、上流待ちの `lint:all` で止まることを確認した。
ローカル（origin/main `bdd8681`、Yarn 4.18.1）では同じ手順で `lint:all` exit 1、`build:all` exit 0 だった。

## ケース 2: 解除できる状態 → 撤去 PR の作成と冪等性

| 項目 | 1 回目 | 2 回目（再実行） |
| --- | --- | --- |
| run | [37284856184](https://github.com/kmryst/idp-golden-path/actions/runs/37284856184) | [37285118884](https://github.com/kmryst/idp-golden-path/actions/runs/37285118884) |
| probe の結果 | `idp-verify-310-dummy` → `unblocked`、`typescript` → `still blocked` | 同じ |
| `Dependency Unblock Check` | success（緑）。`## UNBLOCKED: idp-verify-310-dummy@1 が通りました — ignore の撤去 PR を作成します（#311）` | 同じ |
| `Dependabot Ignore Removal PR` | success、`pull-request-operation = created` | success、`A pull request already exists`、`pull-request-operation = none` |
| 撤去 PR | [#312](https://github.com/kmryst/idp-golden-path/pull/312)（base `310-verify-ignore-removal-pr`、author `app/kmryst-dependency-bot`、Draft ではない） | #312 のまま。重複 PR なし |
| 追跡 Issue #311 へのコメント | 0 件（本リポジトリ自身の実行ではコメントしない） | 0 件 |

PR #312 の内容:

- タイトル / commit: `chore(deps): 解除条件を満たした Dependabot ignore を撤去する`
- 差分: `.github/dependabot.yml` -6（ダミーの 7 項目コメントとエントリだけ。同じ `ignore:` の下の `typescript` は残り、`ignore:` キーも残る）、
  `scripts/ci/dependabot-unblock.json` -9（ダミーのエントリだけ）
- ラベル: `type:chore` / `area:ci-cd` / `risk:low` / `cost:none`
- 本文末尾: `Closes #311` / `Refs #310`

base が main ではないため、PR 上の required status checks は起動しない（#291 の検証の PR #292 と同じ）。

## ケース 3: 機構の故障（追跡 Issue を close した状態）

Issue #311 を close してから、検証ブランチで再実行した。

| 項目 | 値 |
| --- | --- |
| run | [37286527560](https://github.com/kmryst/idp-golden-path/actions/runs/37286527560) |
| `Dependency Unblock Check` | failure（赤）。`## MECHANISM: 追跡 Issue #311 が closed になっている（ignore が残っている間は OPEN を維持する）` |
| `Dependabot Ignore Removal PR` | skipped（`needs` の暗黙の `success()`） |
| 撤去 PR | #312 は更新されていない（commit 1 件のまま） |

## ユニットテストで確認したこと

`node --test scripts/ci/dependabot-unblock-check.test.mjs`（73 件 pass）で、次を確認している。

- 3 リポジトリの `dependabot.yml`（`scripts/ci/fixtures/dependabot/`）で、各 ignore の削除が他のエントリと他の行を変えないこと、
  ブロック内の全エントリを消すと `ignore:` キーも消えること
- `removal.json` の改ざん（余分なキー・フィールド、パス外の `directory`、パッケージ名・バージョン以外の値、重複）と、
  artifact に `removal.json` 以外のファイルがある場合、台帳の `probe: true` 以外を指す場合の拒否
- 撤去後の作業ツリーで `sync` が `OK` になること、PR 本文に `Closes #<追跡 Issue>` と `Refs #310` が入ること

## 後片付け

- PR #312 を close し、`dependency-bot/dependabot-ignore-removal` ブランチを削除した
- 検証ブランチ `310-verify-ignore-removal-pr` を削除した
- Issue #311 は close 済み（main の台帳に載らないため、OPEN のまま残すと週次の検査 4 で赤になる）
