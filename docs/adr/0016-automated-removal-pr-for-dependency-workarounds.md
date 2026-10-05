# 0016. 不要になった依存関係の回避策・例外の撤去 PR 自動作成を、全台帳と Dependabot ignore に広げる

## ステータス

Accepted

## 日付

2026-10-05

## 決定内容

ADR-0015 で脆弱性以外の yarn resolutions に導入した「解除可能なら GitHub App `kmryst-dependency-bot` が撤去 PR を作る」方式を、
本リポジトリの次の台帳すべてに広げる（Issue #310）。

| 対象 | 台帳 | 「不要」の判定 | 撤去 PR のブランチ | Draft |
| --- | --- | --- | --- | --- |
| Dependabot ignore | `scripts/ci/dependabot-unblock.json` + `.github/dependabot.yml` | `dependency-unblock-check` の probe（機構検査 1〜5 全パス + steps 全成功 = `UNBLOCKED`） | `dependency-bot/dependabot-ignore-removal` | しない |
| npm overrides | `scripts/ci/npm-overrides.json` | 既存の stale 判定（ルート / skeleton の全 `directories` で advisory が再出現しない） | `dependency-bot/npm-overrides-removal` | lockfile が変わるとき |
| 監査例外 | `scripts/ci/yarn-audit-exceptions.json` / `scripts/ci/npm-audit-exceptions.json` | audit ゲートの `unused`（npm はルート / skeleton の両方で `unused`） | `dependency-bot/audit-exceptions-removal` | しない |
| 脆弱性対応の yarn resolutions | `scripts/ci/yarn-resolutions.json` | 既存の stale 判定 | `dependency-bot/yarn-resolutions-removal`（ADR-0015 と同じ PR） | lockfile が変わるとき |

- 方式は ADR-0015 と同じ。probe job は secret を持たず、PR 作成 job は install も台帳の `steps` も実行しない。
  job 間で渡すのは artifact の `removal.json`（外す識別子の一覧と、必要なら `lockfileChanges`）だけで、
  PR 作成 job は信頼できる checkout の台帳で許可リスト照合し、差分と PR 本文を自分で生成する。
  artifact の検査と読み込みは `scripts/ci/removal-request.mjs` に共通化する
- 結果は 3 つに分ける。解除可能 = 緑 + 撤去 PR、まだ必要 = 緑、機構の故障 = 赤（PR は作らない）
- 判定に使うのは本リポジトリ自身の `schedule` / `workflow_dispatch` の実行だけ。PR トリガーの実行と `workflow_call`（消費側）からは撤去 PR を作らない
- 撤去 PR の本文には `Refs #310` を書き、台帳の追跡 Issue が本リポジトリのものであれば `Closes #<追跡 Issue>` も書く
- **Dependabot ignore（ADR-0013 の変更点）**: 本リポジトリ自身の実行では、`UNBLOCKED` を「赤（exit 10）+ 追跡 Issue へのコメント」から
  「緑（exit 0）+ 撤去 PR」に変える。消費側（`workflow_call`）は従来どおり exit 10 + コメントとし、消費側への撤去 PR 化は本 ADR の対象外とする
- 実装は Issue #310 の中で 4 つの PR に分ける。本 ADR を追加する PR では Dependabot ignore だけを実装し、
  他の 3 つは後続の PR で同じ方式に揃える（各 PR で運用正本を更新する）

運用手順の正本は、Dependabot ignore は [docs/operations/dependency-unblock-check.md](../operations/dependency-unblock-check.md)、
それ以外は [docs/operations/security-scanning.md](../operations/security-scanning.md) とする。

## 背景

ADR-0015 は脆弱性以外の yarn resolutions だけを対象にした。残りの台帳は、不要になっても次の通知しか出ない。

| 対象 | 現在の通知 |
| --- | --- |
| 脆弱性対応の yarn resolutions | `Yarn Resolutions Inventory` が赤（stale） |
| npm overrides | `npm Overrides Inventory` が赤（stale） |
| 監査例外 | Job Summary の `not detected (remove the stale exception)` 警告のみ |
| Dependabot ignore | `dependency-unblock-check` が赤（exit 10）+ 追跡 Issue へのコメント |

Issue コメントは 11 日間放置された実例がある（#146、ADR-0015 の背景）。週次ジョブの赤も、気づいた人が差分を作るまで残り続ける。
ADR-0015 の撤去 PR は PR 一覧に残り、対応が「レビューしてマージする」だけになるため、同じ方式に揃える。

## 検討した選択肢

### 1. PR の単位: 種類ごとに 1 本（採択） / 対象エントリごとに 1 本 / 全部まとめて 1 本

全部まとめると、lockfile の変わる変更（Draft が必要）と変わらない変更（そのままマージできる）が 1 本に混ざり、
マージできるものまで Draft の待ちに巻き込まれる。また `dependency-unblock-check.yml` と `dependency-audit.yml` は
別のワークフローであり、1 本の PR にまとめるには run をまたいだ集約が要る。
エントリごとにすると、同じ `package.json` の `resolutions` / `overrides` を書き換える PR が互いに衝突する。
種類ごとに固定ブランチを 1 本とし、同じ週に複数のエントリが不要になったら 1 本にまとめる。
脆弱性対応と脆弱性以外の yarn resolutions はどちらも `backstage/package.json` の `resolutions` を書き換えるため、同じ PR にする。

### 2. Draft にする条件: lockfile が変わるときだけ（採択）

ADR-0015 選択肢 8 の案 A（lockfile は PR に含めず、変わる場合は Draft にして人が `yarn install` / `npm install` を 1 コミット足す）をそのまま使う。
監査例外と Dependabot ignore の撤去は lockfile に影響しないため Draft にしない。

### 3. Dependabot ignore の job 分割: probe と撤去 PR 作成を分ける（採択） / 1 job のまま

ADR-0013 選択肢 8 は、台帳の `steps`（任意のシェルコマンド）を実行する job に `issues: write` があることについて、
「artifact の受け渡しでジョブ構造が複雑になる割に得られる分離が限定的」として job を分けず、子プロセスの環境からトークンを除去して対処した。
撤去 PR の作成には Contents: write のトークンが要り、影響は `issues: write` より大きい。ADR-0015 選択肢 5 と同じ理由で分ける。
PR 作成 job は `steps` を一切実行せず、`dependabot.yml` の書き換えも評価器の行単位の抽出（`extractIgnoreEntries`）を拡張した削除で行う。
YAML を再シリアライズしないのは、他のコメントを壊さないためである。撤去後の作業ツリーで `sync` が exit 0（ignore と台帳の 1:1 対応）になることを、PR 作成前に確かめる。

### 4. 本リポジトリの `UNBLOCKED` の色: 緑（採択） / 赤のまま

ADR-0013 選択肢 3 は「新しい通知インフラを足さずに人へ確実に届く唯一の経路が失敗通知」として朗報を赤にした。
撤去 PR はその「確実に届く経路」の代わりになる。赤のままにすると、撤去 PR が開いている間も毎週赤になり、
本物の故障（`MECHANISM`）と見分けにくくなる。ADR-0015 の「解除可能 = 緑 + 撤去 PR」と揃える。
PR 作成 job が失敗した場合（照合の拒否、トークン発行の失敗など）は、その job が赤になる。

### 5. 消費側への適用: 本 ADR の対象外（採択） / 消費側にも App をインストールする

消費側（現在は ticket-c2c-platform が `@v1.7.1` で呼ぶ）にも撤去 PR を作らせるには、App のインストール先を広げ、
リポジトリごとに secret を登録する必要がある。ユーザーの判断（2026-10-05）で、まず本リポジトリだけを対象にした。
消費側は従来どおり exit 10 + コメントで、評価器は `IDP_UNBLOCK_REMOVAL_DIR` が渡されない限りこの動作を変えない。

### 6. 撤去 PR の判定と解除条件の網羅

撤去 PR は「probe の `steps` が全て通った」ことだけを根拠に作られる。したがって `steps` が解除条件を網羅していないと、早すぎる撤去 PR が立つ。
Issue #305（typescript 7）の解除条件には `build:all` が TypeScript 7 で通ることも含まれるが、`steps` は `yarn up typescript@7` → `yarn lint:all` だけだった。
「build してみないと本当にバージョンアップしてよいのかわからない」（ユーザー、2026-10-05）ため、`steps` を次の順に変えた。

1. `yarn up typescript@7`
2. `yarn up -R rollup-plugin-dts`（`@backstage/cli-module-build` の `^6.1.0` の範囲で 6.5.1 に解決。resolutions は不要）
3. `yarn add -D @typescript/typescript6@^6`
4. `yarn lint:all`
5. `yarn build:all`

2026-10-05 のローカル実測（origin/main `bdd8681`、Yarn 4.18.1）では、4 が exit 1（`@typescript-eslint` が TypeScript 7 の JS API に未対応。上流待ち）、
5 が exit 0 だった。手順 2・3 は probe の作業ツリーの中だけの変更であり、ignore を外した後に Dependabot が出す更新 PR では
同じ作業が要る。これは追跡 Issue（#305）の本文に書き、撤去 PR の本文からも参照させる。

## 採択理由

- 台帳ごとに異なっていた「不要になったときの知らせ方」（赤 / 警告 / Issue コメント）が、見落とされない撤去 PR に揃う
- ADR-0015 で実地検証済みの信頼境界（artifact は識別子だけ、差分は信頼できる checkout から生成）と App のトークン運用をそのまま流用でき、App の権限（Contents / Pull requests）を増やさない
- 種類ごとの固定ブランチにすることで、Draft の要否が混ざらず、同じファイルを書き換える PR どうしの衝突も起きない
- 消費側の挙動を変えないため、reusable workflow の契約（ADR-0008）とタグ運用に影響しない

## 影響

- 本リポジトリの `Dependency Unblock Check` は、`UNBLOCKED` の週に緑のまま `Dependabot Ignore Removal PR` job が撤去 PR
  （`chore(deps): 解除条件を満たした Dependabot ignore を撤去する`、`type:chore` / `area:ci-cd` / `risk:low` / `cost:none`）を作る。
  追跡 Issue へのコメントは投稿しない
- 消費側の caller が `dependency-unblock-check.yml` を新しいタグで呼ぶ場合、評価器の sparse checkout に `scripts/ci/removal-request.mjs` が加わる（caller 側の変更は不要）
- 撤去 PR をマージする前に、追跡 Issue の解除条件のうち自リポジトリ側の作業が main に入っているかを確認する。入っていなければ、Dependabot の更新 PR に同じ作業を足す
- 新しい ignore を追加するときは、解除条件の全項目を probe の `steps` で確かめられるようにする（自リポジトリ側の作業も `steps` の中で再現する）
- `docs/operations/github-flow-guardrails.md` の permissions 一覧は変わらない。新しい job は `permissions: contents: read` のままで、書き込みは App のトークンで行う

## 関連

- [ADR-0013](./0013-dependency-unblock-check.md) — Dependabot ignore の probe と台帳。本 ADR で本リポジトリの `UNBLOCKED` の通知方式を変える
- [ADR-0015](./0015-yarn-resolutions-probe-and-automated-removal-pr.md) — 撤去 PR 自動作成の方式と信頼境界の初出
- [ADR-0008](./0008-ci-guardrails-as-reusable-workflows-with-tag-pinning.md) — reusable workflow の契約。消費側の挙動は変えない
- [docs/operations/dependency-unblock-check.md](../operations/dependency-unblock-check.md) — Dependabot ignore の運用正本
- [docs/operations/security-scanning.md](../operations/security-scanning.md) — resolutions / overrides / 監査例外の運用正本
- [検証記録 2026-10-05](../operations/verification/2026-10-05-dependabot-ignore-removal-pr/README.md) — Dependabot ignore の撤去 PR の実地検証（解除不可 / 作成と冪等性 / 機構の故障）
- Issue #310 — 本 ADR の対象
- Issue #305 — typescript 7 の ignore の追跡 Issue（`steps` の変更）
- Issue #146 — Issue コメントが見落とされた例
