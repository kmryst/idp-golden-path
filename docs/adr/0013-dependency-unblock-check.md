# 0013. Dependabot ignore の解除条件を週次で実測検証し、朗報を「赤」で通知する

## ステータス

Accepted

## 日付

2026-08-09

## 決定内容

3 リポジトリ（idp-golden-path / terraform-hannibal / ticket-c2c-platform）の `.github/dependabot.yml` に置いた
`ignore` について、「上流が追いついて解除できる状態になったか」と「ignore / 台帳 / 追跡 Issue が食い違っていないか」を
週次で検証する reusable workflow `dependency-unblock-check` を新設する。

- 名前は `dependency-unblock-check` とし、`canary` を使わない
- 判定は **実際に上げてビルド / テストを通すか（probe）** で行う。peer 宣言の検査では代用しない
- 赤緑を「**緑 = 無操作でよい / 赤 = 人間の出番**」で定義する。**probe 成功（朗報）も赤（exit 10）** とする
- 通知は「赤」と「追跡 Issue へのコメント（記録）」の 2 つに限る。状態ラベルは実装しない
- 機械可読な情報はサイドカー台帳 `scripts/ci/dependabot-unblock.json` に持ち、`dependabot.yml` のコメントとの
  **値まで含む sync 検証**で二重管理を構造的に解消する
- **`pull_request` / `pull_request_target` トリガーを張らない**。これはセキュリティ制約であり、実行契機は
  `schedule` / `workflow_dispatch` / `workflow_call` の 3 種に限る
- reusable workflow としての dual-trigger 提供とタグ固定（`@v1`）の契約は ADR-0008 をそのまま適用する

| 状態 | 色 / exit | Job Summary 先頭行 |
| --- | --- | --- |
| 全 probe 失敗 + 機構検査全パス（期待状態） | 緑 / exit 0 | `OK: still blocked（probe N 件、全て想定どおり失敗）` |
| probe 成功あり（上流が対応した） | 赤 / exit 10 | `UNBLOCKED: <name>@<解決版> が通りました — ignore を外せます（#NNN）` |
| 機構の故障 | 赤 / exit 1 | `MECHANISM: <詳細>` |

複数事象が同時に起きた場合は `MECHANISM` を優先する。機構が壊れていれば probe の結果自体が信用できないためである。
同じ理由で、機構検査に違反がある間は probe を実行しない。

運用手順・台帳スキーマ・赤の対処表の正本は
[docs/operations/dependency-unblock-check.md](../operations/dependency-unblock-check.md) とする。

## 背景

Dependabot の `ignore` には**期限機構がない**。上流が非互換を解消した版を出しても、誰も気づかなければ
ignore は永久に残り、そのメジャー更新だけが恒久的に止まる。

2026-08-09 時点で 3 リポジトリに 9 件の ignore がある（idp-golden-path 1 / terraform-hannibal 5 / ticket-c2c-platform 3）。
これらに気づく手段は「2026-11-02 に人間が棚卸しする」しかなく、その日を過ぎればまた次の期限まで放置される。
さらに ignore・台帳・追跡 Issue・ラベルの整合は人手で維持されており、片方だけ直して片方を忘れる余地が構造的に残っていた。

peer 宣言の検査だけでは判定できない実例もある。terraform-hannibal では `@typescript-eslint` の peer が広がっても
TS5108（`esModuleInterop` 廃止）でビルドが落ちる状態があり、peer 更新は解除の**必要条件にすぎない**ことが実測されている。

## 検討した選択肢

### 1. 命名: `dependency-unblock-check`（採択） / `dependency-canary`

canary はどの用法でも「失敗 = 危険の予兆」を含意する。本ジョブは成功が朗報で赤緑の意味が逆転しており、
読み手が urgency を誤る。また既存の `dependency-audit.yml` と同じ `dependency-*` 族に入れたほうが、
ワークフロー一覧を見ただけで用途が読める。

### 2. 判定方法: 実ビルド probe（採択） / `npm view` の peer 宣言検査

peer 検査は安いが上記の TS5108 の実例で偽陽性を出す。試行 spec は `jsdom@30` のように**固定**する。
`@latest` にすると「7 は通るが 8 は通らない」ときに判定が曖昧になるため。
最新メジャーが台帳の spec より先へ進んだ場合は Job Summary で警告する。

### 3. probe 成功の色: 赤 exit 10（採択） / 緑

当初は「probe 成功 = 朗報だから緑」としていたが**覆した**。その設計では朗報が誰にも届かない。
Issue コメントの通知はボットコメントとして埋もれ、緑の run を人が見に行くことはない。
新しい通知インフラ（Slack 等）を足さずに、人へ確実に届く唯一の経路が GitHub Actions の**失敗通知**である。

「常時赤は alert fatigue を招く」という懸念は残るが、それは **probe 失敗が常態で常に赤くなる場合**にのみ成立する。
本設計では probe 失敗（= まだブロック中）は緑であり、赤くなるのは上流が対応したときだけである。
上流対応は数か月に一度なので、この赤は稀で、むしろ強いシグナルとして機能する。

赤には「朗報（exit 10）」と「故障（exit 1）」の 2 種類があり、両者は exit code と Job Summary の先頭行で見分ける。

### 4. 通知経路: 赤 + Issue コメント（採択） / `ready-to-unblock` 状態ラベル

状態ラベルは**不採用**とする。通知経路を 2 つに絞り、増やさない。
Issue コメントは通知手段ではなく「いつ解除可能になったか」の**記録**として位置づけ、
probe 成功時に**赤で exit する前に**投稿する。HTML マーカー
`<!-- dependency-unblock-check: <name>@<解決版> -->` で同一解決版の連投を防ぐ。
unblocked が数週続けば毎週赤くなるがコメントは増えない。赤が続くこと自体が「人間が未対応」の正しい表現である。

追跡 Issue が CLOSED ならコメントせず、機構の故障として赤にする。

### 5. 対象フラグの置き場所: サイドカー台帳 + sync 検証（採択） / `dependabot.yml` コメントへの埋め込み / caller の `with:` 指定

`dependabot.yml` のコメントは機械可読でない。かといって別ファイルに持つと二重管理になる。
そこで**値まで含む sync 検証**（検査2）で二重管理を構造的に解消する。役割は次のように分ける。

- `dependabot.yml` のコメント = 「なぜ ignore しているか」の正本（7 項目コメント）
- 台帳 = 機械可読な写し + コメントにない実行情報（試すコマンド、probe 対象か否か）

先例がある。`scripts/ci/yarn-resolutions.json` + `yarn-resolutions-audit.mjs` は
`package.json` にコメントを書けないためサイドカー台帳を置き、毎回同期検証している。
caller の `with:` に書く案は、消費側リポジトリの caller が肥大化し、値の履歴が PR diff に残りにくいため不採択。

### 6. `probe: false` の除外設計

解除条件が「自リポジトリ側の作業待ち」や「方針」である ignore は probe しても永久に失敗し、誤報になる
（例: terraform-hannibal #551 は flat config 未移行、#555 は `@types/node` の major 一致方針が理由）。
これらは `probe: false` + `probe-skip-reason` 必須とする。
ただし**台帳への記載は必須**とする。検査2 の 1:1 対応を成立させるためであり、「試さないから書かない」は許さない。

### 7. 双方向の閉じ忘れ・付け忘れ検知（検査 1〜5）

| # | 検査 | 捕まえる抜け |
| --- | --- | --- |
| 1 | 台帳の `tracking` Issue が OPEN か | ignore が残っているのに Issue を閉じた |
| 2 | 台帳 ⟷ `dependabot.yml` が 1:1 か（`review-by` / `tracking` の値まで） | ignore を足して台帳を書き忘れ / その逆 |
| 3 | 台帳の `tracking` Issue に `dependabot-ignore` ラベルが付いているか | ラベルの付け忘れ |
| 4 | `dependabot-ignore` ラベル付き OPEN Issue が全部台帳にあるか | ignore を外して Issue を閉じ忘れ |
| 5 | `review-by` が過ぎていないか | 期限切れの放置（デッドマンスイッチ） |

検査3 がないと「Issue を立てたがラベルを付け忘れた」が両方すり抜ける。検査1 は Issue が OPEN なので通り、
検査4 はそのラベルなし Issue が列挙されないので空振りで通るためである。
検査3 は検査1 と同じ API レスポンスの `labels` を読むだけで、実装コストはほぼゼロである。
これで `dependabot.yml の ignore ⟷ 台帳 ⟷ ラベル付き OPEN Issue` の対応が両方向で閉じる。

**検知は週次のみで、PR 時には行わない**（選択肢 8 のセキュリティ制約による）。最大 7 日の検知遅延は許容する。
ignore の追加は数か月に一度の頻度であり、実害が小さいためである。

### 8. PR トリガーを張らない（セキュリティ制約）

台帳は**任意のシェルコマンド（`steps`）を運ぶファイル**であり、それを `issues: write` を持つジョブが実行する。
したがって **fork PR（`pull_request` / `pull_request_target`）から本 workflow に到達する経路を作らないことを必須条件**とする。
`pull_request` では fork の場合 `GITHUB_TOKEN` が read-only に落ちるとはいえ、
`pull_request_target` への安易な置換や permissions 昇格の温床になるため、トリガー自体を持たない。

実行契機は `schedule` / `workflow_dispatch` / `workflow_call` の 3 種に限る（消費側 caller も同 3 種に限定する usage contract）。
これにより probe が実行するコマンドは常に **main にマージ済み = レビュー済みの台帳**由来となる。

この制約は実装でも支える。**`sync` サブコマンドはネットワークもコマンド実行も一切行わない**（ファイル検査のみ）。
API と probe を伴う検査は `full` のみに置く。

将来 PR 時の sync 検証を導入する場合の条件は次のとおりとする。

- `sync` サブコマンドのみを実行する（probe 実行なし）
- `permissions` は `contents: read` のみ
- 台帳の `steps` を一切 spawn しない

この 3 条件を満たさない緩和は、本 ADR の改訂を要する。

契約を散文だけに委ねないため、workflow 自身にも `github.event_name` が `pull_request` /
`pull_request_target` なら即座に fail するステップを置く（消費側 caller の書き間違いを callee 側で拒否する）。

あわせて、probe の子プロセスには `GITHUB_TOKEN` / `GH_TOKEN` / `NODE_AUTH_TOKEN` / `NPM_TOKEN` を渡さず、
最初の `actions/checkout` も `persist-credentials: false` とする。probe は「まだ検証していない上流の新メジャー」を
毎週引いて実行する仕組みであり、postinstall スクリプト 1 つで `issues: write` トークンが露出しうるためである。
評価器本体は `process.env` から直接トークンを読むため、この除去は API 呼び出しに影響しない。
job を「probe（`contents: read`）」と「コメント投稿（`issues: write`）」に分割する案は、
artifact の受け渡しでジョブ構造が複雑になる割に得られる分離が限定的なため今回は採らず、
子プロセス環境からのトークン除去で対処する。

### 9. 索引表の廃止と `dependabot-ignore` ラベル検索との関係

有効な ignore の横断一覧は、手書きの索引表ではなく `dependabot-ignore` ラベルの横断検索で得る方針に移行済み
（terraform-hannibal PR #579、3 リポジトリの `dependabot.yml` 先頭にリンクを 1 行追加）。
検査3・検査4 はこのラベル検索が「実態と一致していること」を機械的に担保する位置づけであり、
ラベル運用と本ジョブは相互に補完する。

## 採択理由

- ignore の解除判断に必要な事実（実際にビルドが通るか）を、人間の棚卸し日を待たずに毎週自動で取りに行ける
- 朗報を赤にすることで、新しい通知インフラを増やさずに「気づかれない」問題を解消できる。
  この赤は稀であり、alert fatigue の懸念は probe 失敗が常態化する設計にのみ当てはまる
- 台帳 + 値まで含む sync 検証により、二重管理が「乖離しても気づける」形になる。先例（`yarn-resolutions.json`）と同型で、運用の学習コストが低い
- 検査 1〜5 で ignore / 台帳 / Issue / ラベルの対応が双方向に閉じ、片側だけ直す運用ミスが構造的に検出される
- PR トリガーを持たないことで、台帳がシェルコマンドを運ぶという設計上のリスクを、権限ではなく**到達経路**の遮断で封じている

## 影響

- 週次で月曜 10:15 JST に 1 run 追加される（Dependabot 09:15 / Dependency Audit 09:00・09:45 JST の後）。
  probe が install + build + test を回すため `timeout-minutes: 30` を設定する。GitHub Actions の無料枠内であり、追加コストはない
- 上流が対応した週は**ジョブが赤くなる**。これは異常ではなく朗報であり、対応は「ignore と台帳を外し、追跡 Issue を close する PR を出す」こと
- 新しい ignore を追加する PR では、`dependabot.yml`・台帳・追跡 Issue（`dependabot-ignore` ラベル付き）の 3 点セットが必須になる。
  漏れは翌週の赤で検出される（最大 7 日の遅延）
- 消費側リポジトリ（terraform-hannibal / ticket-c2c-platform）への導入は本 ADR のスコープ外とし、
  caller 追加時は `docs/operations/dependency-unblock-check.md` の導入手順に従う
- 本 workflow を含むリリースタグ（`v1.x.y` / `v1`）の付け替えは ADR-0008 の手順に従う

## 関連

- [ADR-0008](./0008-ci-guardrails-as-reusable-workflows-with-tag-pinning.md) — reusable workflow の dual-trigger 提供とタグ固定
- [docs/operations/dependency-unblock-check.md](../operations/dependency-unblock-check.md) — 運用正本
- [docs/operations/security-scanning.md](../operations/security-scanning.md) — 脆弱性スキャンの正本（用途が別。混ぜない）
- [検証記録 2026-08-09](../operations/verification/2026-08-09-dependency-unblock-check/README.md) — UNBLOCKED 経路（exit 10）・連投防止・通知到達の実地検証
- Issue #160 — 本 workflow の新設
- Issue #146 — jsdom major 更新 ignore の追跡 Issue（本リポジトリ唯一の台帳エントリ）
- Issue #106 — caller / callee の concurrency group デッドロック契約
