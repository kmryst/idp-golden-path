# 0017. 依存関係の回避策の台帳・判定・出口・失敗通知を統一し、Dependabot alert の判断は GitHub 側の状態を正本とする

## ステータス

Proposed（「要確認」と記した判断が確定した時点で Accepted にする）

## 日付

2026-10-24

## 決定内容

本リポジトリが持つ依存関係の回避策（Yarn resolutions / npm overrides / 監査の期限付き例外 / Dependabot ignore）について、
台帳・「外せるか」の判定・出口（撤去 PR）・定期実行の失敗通知を、次の方針で段階的に揃える（Issue #324）。
Dependabot alert の dismiss と auto-triage rules は自前の仕組みで持たず、GitHub 側の alert の状態を判断の記録先とする。

本 ADR は方針と移行計画を決めるもので、実装は移行計画の各段階の Issue で行う。
運用手順の正本は、Dependabot ignore は [docs/operations/dependency-unblock-check.md](../operations/dependency-unblock-check.md)、
それ以外は [docs/operations/security-scanning.md](../operations/security-scanning.md) とする。

### 1. 自前で持つものと、GitHub 側に任せるもの

| 対象 | 持ち方 |
| --- | --- |
| Yarn resolutions / npm overrides | 台帳 + 機械判定 + 撤去 PR |
| 監査の期限付き例外 | 台帳 + 期限 + 撤去 PR |
| Dependabot ignore（`.github/dependabot.yml`） | 台帳 + probe + 撤去 PR |
| `@dependabot ignore` コメント | 使わない。既存分は `dependabot.yml` と台帳へ移設する |
| Dependabot の PR を閉じる | 抑止の手段として使わない |
| Dependabot alert の手動 dismiss | GitHub 側（`dismissed_reason` / `dismissed_comment`）を記録先とする。台帳に載せない |
| Dependabot auto-triage rules | GitHub に任せる。台帳と突き合わせない |
| high 未満の open な Dependabot alert | 台帳に載せない。修正するか、dismiss で判断を記録する |

- **CI 側で「判断済み」と数える台帳は、GHSA を記録する 3 種**（`scripts/ci/yarn-resolutions.json`、`scripts/ci/npm-overrides.json`、
  `scripts/ci/yarn-audit-exceptions.json` / `scripts/ci/npm-audit-exceptions.json`）に限る。
  Dependabot ignore は「更新を止める」宣言であって GHSA を受容した記録ではないため、数えない。
  これは Issue #212 の前提（ignore を含む 3 台帳との照合）を変更する
- **open のまま残してよい Dependabot alert は、GHSA が上の 3 種の台帳のいずれかに載っているものだけ**とする。
  それ以外の open な alert は、修正するか、GitHub 側で dismiss して判断を記録する。
  「open かつどの台帳にも載っていない」状態を放置と定義し、その検出は Issue #212 の評価器が担う
- dismiss は人が行い、自動化しない。`dismissed_reason` の選び方と `dismissed_comment` の必須項目
  （根拠・再評価の条件・修正中なら追跡 Issue）は security-scanning.md に定める。
  この記録書式は code scanning alert の dismiss にも共通に使う（通知と放置検知の仕組みは Issue #336 で決める）
- auto-triage rules（GitHub preset「Dismiss low impact issues for development-scoped dependencies」）で `auto_dismissed` になった alert は、
  GitHub 側で判断済みとして扱い、台帳にも運用ドキュメントにも転記しない。GitHub は advisory や scope のメタデータが変わると
  alert を再 open することがあり、その時点で上の規則に従って扱えばよい
- **監査の期限付き例外を登録した alert は dismiss しない**（要確認 A）。期限の管理は CI 側の `expires` に一本化し、
  期限を持たない dismiss と二重に記録しない。Security タブ上は open のまま残るが、#212 の評価器では台帳に載っているため放置に数えない
- CI の監査の severity 閾値（high）は変えない。閾値を下げると Backstage の依存グラフで修正版のない moderate が常時 fail になる
  （security-scanning.md「severity 閾値と fail/warn ポリシー」の判断を維持する）

### 2. 台帳の形式

台帳は 1 ファイルに統合せず、仕組みごとのファイルと評価器を分けたまま、項目の名前と意味を揃える。

| 項目 | キー | 持つ台帳 |
| --- | --- | --- |
| 対象 | `pattern` / `id` / `dependency-name` | 全部（キー名は仕組み固有のまま） |
| 理由 | `reason` | resolutions / overrides は必須。監査の期限付き例外は任意項目として追加する |
| 追跡 Issue | `tracking` | 期限を持つ台帳は必須。機械判定で外せる台帳は任意 |
| 期限 | `expires` / `review-by` | 監査の期限付き例外 / Dependabot ignore |
| 検証方法 | `advisories` / `probe` / `steps` | resolutions / overrides / Dependabot ignore |
| 適用先 | `directories` / `directory` | npm overrides / Dependabot ignore |

- `expires`（期限切れで CI の監査が fail する）と `review-by`（期限切れで棚卸しが赤になる）は意味が違うため、名前を 1 つに揃えない
- 既存のキー名は消費側の input 契約（`npm-audit-exceptions` / `yarn-audit-exceptions` の JSON 配列）に含まれるため変更しない。
  追加は任意項目に限り、未指定なら従来どおり動く
- 非セキュリティ起因の台帳（`scripts/ci/yarn-resolutions-non-security.json`、将来の `npm-overrides-non-security.json`）にも
  任意の `advisories` を持たせ、固定している版に関係する advisory を記録できるようにする（問題 5）。
  脆弱性の検知そのものは自前で持たず、実グラフの `Dependency Audit` と Dependabot alert に任せる
- 1 ファイルに統合しない理由: 同期（sync）の相手が `backstage/package.json`・ルート / skeleton の `package.json`・`dependabot.yml` と
  台帳ごとに違い、評価器も消費側の sparse checkout に個別に含まれている。統合すると消費側の契約に触れる割に、
  得られるのは「1 か所で一覧できる」ことだけで、それは正本の一覧表で足りる

### 3. 判定

- 「外せるか」の判定は npm overrides の方式に揃える。**1 件ずつ外し**、台帳記載の advisory が **severity を問わず**再出現せず、
  **外す前に無かった High / Critical が出ない**ことを確かめる。新規の High / Critical は機構の故障として赤にし、撤去 PR は作らない
- Yarn resolutions（セキュリティ起因）の「全部外して再出現を見る」方式は上に置き換える（問題 1。adm-zip / undici の誤判定の原因）
- probe（非セキュリティ起因の resolutions、Dependabot ignore）と期限（監査の期限付き例外）は、advisory の再出現で判定できない
  仕組みの判定方法としてそのまま残す
- 判定スクリプトは 1 本化しない。評価器は仕組みごとに分けたまま、撤去要求の受け渡し（`removal.json`）の契約を
  `scripts/ci/removal-request.mjs` に寄せる現状を維持し、共通化できる判定の部品（1 件ずつ外す手順、新規 High / Critical の検出）は
  共有モジュールに切り出す

### 4. 出口

- 本リポジトリ自身の `schedule` / `workflow_dispatch` 実行では、「外せる」の出口を**撤去 PR に一本化**する。
  未実装の監査の期限付き例外の撤去 PR（ADR-0016 の分割 3、ブランチ `dependency-bot/audit-exceptions-removal`）を実装し、
  Yarn resolutions（セキュリティ起因）の stale も「赤」ではなく撤去 PR にする（ADR-0016 の分割 4）
- 撤去 PR の方式（job の分離、artifact は識別子だけ、差分は信頼できる checkout から生成、GitHub App のトークン）は
  ADR-0015 / ADR-0016 のまま変えない
- 消費側（`workflow_call`）の出口は変えない（要確認 B）。Dependabot ignore は exit 10 + 追跡 Issue へのコメント、
  監査の期限付き例外は Job Summary の警告のまま。消費側に撤去 PR を作らせるには GitHub App のインストールと
  secret / variable の登録という新しい前提が要り、ADR-0008 の「消費側リポジトリへの新たな前提の追加」（破壊的変更、`v2`）に当たる

### 5. 定期実行の失敗通知

- 定期実行（`Dependency Audit` / `Dependency Unblock Check`）の失敗を 1 か所で知らせる仕組みを置く（問題 3）。
  失敗したら固定の Issue を開くか更新し、成功したら close する
- 実装の候補は、対象 workflow の完了を `workflow_run` で受ける独立した workflow（要確認 C）。
  既存 workflow の `permissions` を変えずに済み、消費側の契約にも触れない
- 同じ Issue に、`dependency-bot/*` ブランチの撤去 PR が一定日数 open のままである旨も載せる（問題 4 の放置検知。日数は要確認 C）

### 6. Issue #324 の問題 1〜8 の扱い

| 問題 | 扱い | 対応する節 |
| --- | --- | --- |
| 1. 判定基準が 3 通りある | 対処 | 3 |
| 2. 出口が不揃い | 対処 | 4 |
| 3. 定期チェックの連続失敗に気づけない | 対処 | 5 |
| 4. 撤去 PR のマージ実績がない | 対象外 | 下記 |
| 5. 非セキュリティ起因の resolution が脆弱版を固定している可能性 | 対処 | 2 |
| 6. high 未満の open alert と Dependabot security updates の失敗 | 対処 | 1、下記 |
| 7. メジャーを跨ぐ resolutions | 対象外 | 下記 |
| 8. 互換処理に頼った peer の不一致 | 対象外 | 下記 |

- **問題 4**: 撤去 PR の作成・冪等性・required status checks の起動は検証ブランチで確認済み（#292 / #294、#312 / #314 / #316）。
  main を base にした撤去 PR は「外せるエントリ」が実際に出ないと作られず、人工的に不要なエントリを main に入れてまで作る価値はない。
  設計では解決せず、初めて main 向けに立ったときに required status checks の起動を検証記録に残す。放置は 5 の失敗通知で検知する
- **問題 6 の個別対処**（2026-10-15 時点で `security_update_not_possible` で失敗していた 6 本。要確認 D）
  - smol-toml（ルート / skeleton）: 対処済み。#352 で markdownlint-cli2 を 0.24.0 に上げ、依存元の更新で修正版 1.9.1 に解決された。
    npm overrides は追加しない（再解決で修正版が選ばれるようになり、overrides の追加基準を満たさない）。
    当初は `markdownlint-cli2@0.23.3` が `1.8.0` を exact pin していたため overrides `^1.9.0` を追加する案だった
  - katex（ルート / skeleton）: 依存元 `micromark-extension-math` の range は `^0.16.0` で、修正版 0.18.2 はその外にある。
    0.x の caret range を跨ぐ上書きは ADR-0008 追記 2026-10-14 の「別 major」と同じに扱い、overrides しない。
    markdownlint は katex の描画コードパスを使わないため、`not_used` で dismiss する（推奨）か、open のまま残す
  - postcss-selector-parser / @graphql-tools/utils（`/backstage`）: Issue #211 の仕分けで決める。@graphql-tools/utils は
    監査の期限付き例外（#317）に載っているため open のまま残してよい
  - dismiss した alert に対しては Dependabot が security update を試みなくなるため、失敗の run は止まる
- **問題 7**: Issue #318 で検討し、ADR-0008 追記 2026-10-14 で「major を跨ぐ resolutions は認めない」と確定済み。
  台帳の項目にも判定にも影響しないため、本 ADR では扱わない
- **問題 8**: 互換処理（`fixupPluginRules` など）で peer の不一致を許容している状態は、ticket-c2c-platform #427 で追跡する。
  台帳の種類として加えるかは再検討条件に置く

### 7. 消費側への影響とリリース方針

- 移行計画の段階 1〜5 は、reusable workflow の inputs・exit code（`UNBLOCKED` の 10）・job の id と name・permissions を変えない。
  新しい job と判定の変更は `github.repository == 'kmryst/idp-golden-path'` の条件を持ち、消費側では skipped になる
- 監査の期限付き例外の JSON に任意項目（`reason`）を追加する変更は、未指定なら従来どおり動く非破壊的な変更として `v1` の minor リリースにする
  （ADR-0008 のリリース手順。例: `v1.8.0`）。追加しない限り消費側の caller を書き換える必要はない
- 「Dependabot ignore を GHSA の受容に数えない」方針は、消費側で動く `dependency-unblock-check` の評価器の挙動を変えない
- `v2` になる条件: 消費側に撤去 PR を作らせる（App のインストール前提）、`expires` / `review-by` の改名、`UNBLOCKED` の exit code の変更。
  本 ADR ではいずれも採らない

### 8. 移行計画

| 段階 | 内容 | Issue |
| --- | --- | --- |
| 0 | 本 ADR と正本の更新 | #324 |
| 1. 台帳形式 | 共通項目の定義、`reason` / `advisories` の任意追加、`@dependabot ignore` 5 件の移設、#211 の仕分け、got / alert #128 の確認 | 新規（#211 / #217 / #219 と紐付け） |
| 2. 判定 | Yarn resolutions（セキュリティ起因）の stale を 1 件ずつの方式へ | 新規 |
| 3. 出口 | 監査の期限付き例外の撤去 PR、Yarn resolutions（セキュリティ起因）の撤去 PR | 新規（ADR-0016 の分割 3 / 4） |
| 4. 失敗通知 | 失敗時に固定 Issue を開閉する workflow、撤去 PR の放置検知 | 新規 |
| 5. 突き合わせ | open alert と台帳の照合（#212）、`dependabot.yml` 外の ignore の検出（#219） | 既存 |

- 1 → 2 → 3 は順に行う。撤去 PR（3）は判定（2）の正しさに依存し、判定は台帳の項目（1）に依存する
- 4 は 1〜3 と独立しており、並行して進めてよい。定期実行の失敗は現に続いているため、早く着手する価値がある
- 5 の #212 は 1 の仕分けの完了が前提（#212 本文のとおり、初回実行を緑から始める）。#212 の照合対象は本 ADR の 1 に従って
  GHSA を記録する 3 種の台帳に改める
- 段階 1 の `@dependabot ignore` 5 件（react / react-dom / @types/react-dom / react-router / react-router-dom）の移設（要確認 E）:
  `dependabot.yml` の `update-types: ["version-update:semver-major"]` と台帳のエントリに置き換える。解除条件は React 19 移行（#58）という
  自リポジトリ側の作業待ちのため `probe: false` とし、`review-by` は既存の typescript と同じ 2026-11-02 に揃える。
  `react-router` は `packages/app/src` から import されていない直接依存であり、依存を外せるなら ignore も不要になる。
  移設後は `@dependabot ignore` コメントを使わず、新しい ignore は dependency-unblock-check.md の手順で追加する

## 背景

2026-10-15 時点の棚卸し（Zenn 記事
「[依存関係の workaround 大統一理論！！！ ～泣きながら現状を直視する～](https://zenn.dev/kmryst/articles/dependency-workaround-inventory)」、
Issue #324 のコメント）で分かった状態は次のとおり。件数はいずれも同時点のもので、正本には転記しない。

- 回避策の仕組みは、本リポジトリと消費側 3 リポジトリで 9 つある（Yarn resolutions、npm overrides、監査の期限付き例外、
  Dependabot alert の dismiss、auto-triage rules、`dependabot.yml` の ignore、`@dependabot ignore` コメント、Dependabot の PR を閉じる、
  code scanning alert の dismiss）。ADR-0008 追記 2026-07-28 / 2026-08-05、ADR-0013、ADR-0015、ADR-0016 で 1 つずつ足してきた結果、
  台帳・判定基準・定期実行・出口がそれぞれ別になっている
- **advisory は CI の監査と Dependabot alert の 2 か所で別々に検知され、片方を止めてももう片方は止まらない。**
  監査の期限付き例外は alert を閉じず、dismiss は CI の監査結果を変えない。braces（GHSA-vfj7-8cjw-p6xm）は
  CI 側が監査の期限付き例外、GitHub 側が auto-triage rules と、別々の仕組みで止まっていた
- 記録の持ち主が分かれている。resolutions / overrides / 監査の期限付き例外 / `dependabot.yml` の ignore はリポジトリ内のファイルに、
  dismiss / auto-triage rules / `@dependabot ignore` コメントは GitHub 側にしか残らない。本リポジトリの `auto_dismissed` 8 件のうち
  5 件はどの台帳にも運用ドキュメントにも出てこない。`@dependabot ignore` コメント由来の ignore 5 件は `dependabot.yml` にも台帳にも載っておらず、
  `Dependency Unblock Check` からも見えない（Issue #219）
- open な Dependabot alert 19 件の内訳は、監査の期限付き例外に載っているもの 3 件、修正版が `@dependabot ignore` の範囲に入るもの 2 件、
  Dependabot security updates が `security_update_not_possible` で上げられなかったもの 12 件、修正版そのものが無いもの 2 件。
  16 件は moderate / low で、CI の監査の対象外のため受容の判断を記録する場所がない
- 台帳・判定・撤去 PR の実装はプラットフォーム側だけにあり、消費側の `overrides`（ticket-c2c-platform の 2 件）は何にも追跡されていない

Issue #324 の問題 1〜6 の事実関係:

1. Yarn resolutions（セキュリティ起因）の stale 判定は台帳記載の GHSA の再出現しか見ず、adm-zip / undici を「不要」と誤判定した（run 37278531255）
2. 出口は撤去 PR（Yarn resolutions / npm overrides / Dependabot ignore）、Job Summary の警告のみ（監査の期限付き例外）、何もしない（dismiss / auto-dismiss）に分かれる
3. 定期実行の連続失敗に気づく仕組みは GitHub Actions 標準の失敗通知メールだけで、`Dependency Unblock Check` は 2026-09-28 / 10-05 に
   `fetch failed` で、`Dependency Audit` の定期実行は 2026-10-05 から失敗していた
4. 自動で作られた撤去 PR #292 #294 #312 #314 #316 はすべて検証用で、main 向けにマージされた実績がない
5. `@yarnpkg/core/got` → `npm:11.8.2` が Dependabot alert #128 に該当する可能性があるが、非セキュリティ起因の台帳には advisory を書く場所がない
6. moderate / low の open alert をどの仕組みも扱っておらず、Dependabot security updates が main への push ごとに `security_update_not_possible` で 6 本失敗し続けている

## 検討した選択肢

### 1. 台帳の置き方: 分けたまま形式を揃える（採択） / 1 ファイルに統合する

npm overrides が `directories` で適用先を宣言して 1 ファイルにした判断（security-scanning.md）は、ルートと skeleton に同じ overrides を入れる
不変条件を台帳の形で守るためのもので、仕組みを跨いだ統合の根拠にはならない。統合すると sync の相手が 3 種類ある台帳を 1 つの評価器で扱うことになり、
消費側の sparse checkout と input 契約にも触れる。一覧性は正本の表で担保する。

### 2. 判定基準: npm overrides の方式（採択） / Yarn resolutions の方式 / 期限のみ

全部を一度に外す方式は、ある上書きを外したことで依存グラフから消えた依存に対する別の上書きが「不要」に見える（#315 のレビュー、ADR-0016）。
期限だけの判定は、機械判定できる resolutions / overrides に任意の日付を持ち込む退行になる（security-scanning.md の「期限は持たせない」判断）。

### 3. dismiss の記録先: GitHub 側の alert の状態（採択） / dismissed を 4 つ目の台帳にする / dismiss を禁止して全件を台帳に載せる

dismissed を台帳に転記すると、GitHub 側の状態との同期をもう 1 つ保守することになる。`dismissed_reason` / `dismissed_comment` は
REST API で読め、Issue #212 の評価器が照合に使える。dismiss を禁止すると moderate / low の alert の判断を記録する場所が無くなる。

### 4. high 未満の open alert: 修正か dismiss（採択、要確認） / open のまま放置を許容する / 監査の閾値を moderate に下げる

放置を許容すると、Issue #212 の「全ての open alert が人の判断を経ている」を機械で保証できない。閾値を下げると
修正版のない moderate で CI が常時 fail し、alert fatigue で検知能力を失う（ADR-0008 追記 2026-08-05 と同じ失敗）。

### 5. 消費側の出口: 変えない（採択、要確認） / 消費側にも撤去 PR を作らせる

ADR-0016 選択肢 5 の判断（2026-10-05）を維持する。App のインストールと secret 登録は消費側への新しい前提であり `v2` になる。
消費側の Dependabot ignore には台帳と probe があり、`UNBLOCKED` の赤で人に届く経路は既にある。

### 6. 失敗通知: 固定 Issue を開閉する独立 workflow（採択、要確認） / 失敗通知メールのまま / 各 workflow に Issue 作成 step を足す

メールだけでは連続失敗に気づけなかった（問題 3 の実例）。各 workflow に step を足すと `dependency-audit.yml` の `permissions` に
`issues: write` が増え、消費側の caller にも影響する。`workflow_run` で受ける独立 workflow なら既存 workflow に触れない。

### 7. `@dependabot ignore` コメント: 移設して以後使わない（採択、要確認） / 残す

コメント由来の ignore は `>= 7.a, < 8` のような範囲指定で登録され、修正版が範囲に入れば security update も止める。
リポジトリ内のファイルから辿れず、`Dependency Unblock Check` の 1:1 対応検査からも見えない。
`dependabot.yml` の `update-types: ["version-update:semver-major"]` へ移すと抑止範囲は「そのメジャー 1 つ」から「全メジャー」に広がるが、
解除条件（React 19 移行）が満たされるまで全メジャーを止めてよい ignore であり、実害はない。

### 8. 判定スクリプトの 1 本化: しない（採択） / 1 本にする

評価器は仕組みごとに外し方・検証方法が違い、消費側で動くもの（`dependabot-unblock-check.mjs`、`*-audit-policy.mjs`）と
本リポジトリ専用のもの（`*-resolutions-audit.mjs`、`npm-overrides-audit.mjs`）で実行環境も違う。1 本にすると消費側の sparse checkout に
本リポジトリ専用のコードが入る。共通化は判定基準と `removal.json` の契約に留める。

## 採択理由

- GHSA を記録する 3 種の台帳だけを「CI 側で判断済み」と数え、残りは GitHub 側の alert の状態に任せることで、
  「この advisory を受容した」という判断の記録先が 1 つに決まる（台帳にあるか、dismiss されているか、のどちらか）
- 判定を npm overrides の方式に揃えることで、問題 1 の誤判定を構造的に塞ぎ、撤去 PR の前提（判定の計測がそのままマージ後の状態の検証になる）を全台帳で満たす
- 出口を撤去 PR に揃えることで、ADR-0016 が目指した「不要になったときの知らせ方の統一」が監査の期限付き例外と Yarn resolutions（セキュリティ起因）にも及ぶ
- 消費側の契約に触れない範囲で段階を切ることで、`v1` のまま移行でき、ADR-0008 のタグ運用と矛盾しない
- 1 ファイル統合と判定スクリプトの 1 本化を見送ることで、保守の対象を増やさずに「統一した自動化にしつつ、保守は軽くする」という Issue #324 の目標に収まる

## 影響

- `docs/operations/security-scanning.md` に回避策の一覧表と「Dependabot alert の扱い」節を追加し、監査の期限付き例外と alert の関係を明記する（本 PR）
- `docs/operations/dependency-unblock-check.md` に `@dependabot ignore` コメントを使わない方針と、ignore が GHSA の受容に数えられないことを明記する（本 PR）
- Issue #212 の照合対象を「GHSA を記録する 3 種の台帳」に改め、Dependabot ignore の台帳を外す（#212 本文の更新は段階 5 の着手時）
- Issue #217 / #219 は段階 1 の移設と段階 5 の検出に対応づける
- 評価器・workflow の変更は段階 1〜4 の Issue で行い、各 PR で正本を更新する。本 ADR を含む PR ではコードを変更しない
- 消費側（ticket-c2c-platform / terraform-hannibal）の caller に変更はない。`v1` の付け替えで届くのは本リポジトリ専用の job の追加だけで、
  消費側では skipped になる

## 再検討条件

- 消費側で `UNBLOCKED` のコメントが見落とされる実例が再び出たとき（消費側への撤去 PR、`v2` の検討）
- 互換処理に頼った peer の不一致（問題 8）が本リポジトリでも必要になったとき（台帳の種類の追加）
- GitHub が Dependabot alert の dismiss に期限や再評価の仕組みを提供したとき（監査の期限付き例外と alert の関係の見直し）
- 監査の期限付き例外や resolutions の件数が増え、1 週 1 件の撤去 PR では追いつかなくなったとき

## 関連

- Issue: [kmryst/idp-golden-path#324](https://github.com/kmryst/idp-golden-path/issues/324)
- sub-issue: [#212](https://github.com/kmryst/idp-golden-path/issues/212)（open alert と台帳の照合）/
  [#336](https://github.com/kmryst/idp-golden-path/issues/336)（code scanning alert の放置検知）
- 関連 Issue: [#211](https://github.com/kmryst/idp-golden-path/issues/211)（moderate / low の alert の仕分け）/
  [#217](https://github.com/kmryst/idp-golden-path/issues/217) / [#219](https://github.com/kmryst/idp-golden-path/issues/219)（ignore 条件の一元化と検出）/
  [#58](https://github.com/kmryst/idp-golden-path/issues/58)（React 19 移行）/
  [#318](https://github.com/kmryst/idp-golden-path/issues/318)（メジャーを跨ぐ resolutions、closed）
- [ADR-0008](./0008-ci-guardrails-as-reusable-workflows-with-tag-pinning.md) — reusable workflow の契約とタグ運用。追記 2026-07-28 / 2026-08-05（期限付き例外）、2026-10-14（別 major の修正版）
- [ADR-0013](./0013-dependency-unblock-check.md) — Dependabot ignore の probe と台帳
- [ADR-0015](./0015-yarn-resolutions-probe-and-automated-removal-pr.md) — 撤去 PR の方式と信頼境界
- [ADR-0016](./0016-automated-removal-pr-for-dependency-workarounds.md) — 撤去 PR の対象拡大。分割 3 / 4 を本 ADR の段階 3 で実装する
- [docs/operations/security-scanning.md](../operations/security-scanning.md) — resolutions / overrides / 監査の期限付き例外 / Dependabot alert の運用正本
- [docs/operations/dependency-unblock-check.md](../operations/dependency-unblock-check.md) — Dependabot ignore の運用正本
- 参考資料: [依存関係の workaround 大統一理論！！！ ～泣きながら現状を直視する～](https://zenn.dev/kmryst/articles/dependency-workaround-inventory)（2026-10-15 時点の棚卸し）
- [GitHub Docs: REST API endpoints for Dependabot alerts](https://docs.github.com/en/rest/dependabot/alerts)（`dismissed_reason` の値）
- [GitHub Docs: Dependabot auto-triage rules](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-auto-triage-rules)
