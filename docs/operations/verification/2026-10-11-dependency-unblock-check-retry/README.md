# Dependency Unblock Check の GitHub API 再試行 実地検証記録 (2026-10-11)

Issue #322（PR #323）で入れた「接続切れの `fetch failed` に対する GET の 1 回再試行」が、実際の GitHub Actions
ランナー（Node.js 24.21.0）で効くことを、Issue #326 の実装ブランチから切った検証ブランチ 2 本を
`workflow_dispatch` で実走させて確認した記録。
run はどちらも `Dependency Unblock Check`（`.github/workflows/dependency-unblock-check.yml`）の `full` モード。

## 背景

2026-09-28（run 36388464626）と 2026-10-05（run 37275307924）の `schedule` 実行が、
probe 後の GitHub API 呼び出しで `MECHANISM: Unexpected evaluator error: fetch failed` になった。
probe の `spawnSync` でイベントループが止まっている間にサーバー側で閉じられた keep-alive 接続を、
Node.js 24.21.0 同梱の undici 7.29.1 が再利用することが原因である（詳細は #322）。

本リポジトリ自身の実行は #313 以降、UNBLOCKED でも撤去 PR を作る経路で、probe 後に GitHub API を呼ばない。
そこで検証ブランチでだけ `IDP_UNBLOCK_REMOVAL_DIR` を空にし、呼び出し側（`workflow_call`）と同じ
「追跡 Issue へコメントする」経路（`listIssueCommentBodies` の GET → `createIssueComment` の POST）を通した。

## ブランチと Issue

| 名前 | 用途 |
| --- | --- |
| `326-unblock-check-retry-warning` | 実装（main 向け PR の head）。commit `365b619` で再試行時の warning を追加 |
| `326-verify-retry` | 本番。実装ブランチ + ダミーの ignore / 台帳エントリ + `IDP_UNBLOCK_REMOVAL_DIR: ""`（commit `5023eff`）。検証後に削除した |
| `326-verify-retry-control` | 対照。本番ブランチの評価器とテストを #323 より前（`89760e1`）に戻した（commit `5b391a9`）。検証後に削除した |
| Issue #327 | 検証用の追跡 Issue（`dependabot-ignore` ラベル付き）。検証後に close した |

ダミーは `/backstage` の ignore `idp-verify-326-dummy`（npm に実在しない名前、7 項目コメントの `追跡: Issue #327`）と、
台帳の `probe: true` / `steps: ["sleep 120"]` のエントリである。`sleep 120` が `spawnSync` でイベントループを約 2 分止め、
probe 前の GET で使った keep-alive 接続が切れた状態を作る。既存の `typescript` エントリも残したので、probe の合計は約 3 分になる。

## 結果

| 項目 | 対照（修正前の評価器） | 本番（修正後の評価器） |
| --- | --- | --- |
| run | [38118394254](https://github.com/kmryst/idp-golden-path/actions/runs/38118394254) | [38118395840](https://github.com/kmryst/idp-golden-path/actions/runs/38118395840) |
| Node.js（Setup Node.js） | v24.21.0 | v24.21.0 |
| 評価器の単体テスト | 73 件 pass | 81 件 pass |
| 再試行の warning | なし（機能がない） | 1 件。cause は `EPIPE` |
| 判定 | `MECHANISM: Unexpected evaluator error: fetch failed` | `UNBLOCKED: idp-verify-326-dummy@1 が通りました — ignore を外せます（#327）` |
| exit code | 1 | 10（呼び出し側の経路の想定どおりの赤） |
| Issue #327 へのコメント | 0 件 | 1 件（マーカー `<!-- dependency-unblock-check: idp-verify-326-dummy@1 -->`） |

本番の warning（ログの抜粋）:

```text
##[warning]GitHub API GET /repos/kmryst/idp-golden-path/issues/327/comments?per_page=100&page=1 の接続が切れていたため 1 回だけ再試行する（cause: EPIPE）
```

- 対照で `fetch failed` が再現したことで、実ランナーでも probe 中に接続が切れる条件を作れていることを確認した
- 本番では同じ条件で probe 後最初の GET が `EPIPE` で失敗し、1 回の再試行で成功して、POST のコメント投稿まで進んだ
- `typescript` の probe は両 run とも `still blocked`（`yarn lint:all` が exit 1）で、ダミーの UNBLOCKED に巻き込まれていない

## 後片付け

- Issue #327 を close した（main の台帳に載らないため、OPEN のまま残すと週次の検査 4 で赤になる）
- 検証ブランチ `326-verify-retry` / `326-verify-retry-control` を削除した
