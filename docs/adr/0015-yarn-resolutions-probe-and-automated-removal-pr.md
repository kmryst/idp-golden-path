# 0015. 脆弱性以外の yarn resolutions を週次で probe し、解除可能になったら GitHub App で撤去 PR を自動作成する

## ステータス

Accepted

## 日付

2026-10-03

## 決定内容

`backstage/package.json` の resolutions のうち脆弱性以外の理由のもの（`scripts/ci/yarn-resolutions-non-security.json`）について、
「上流が追いついて外せる状態になったか」を週次の `Yarn Resolutions Inventory` で実測し、外せるなら**撤去 PR を自動で作る**。

- 台帳のエントリに任意の `probe` / `tracking` を追加する。`probe.up` は `yarn up -R` に渡す親パッケージ名、`tracking` は解除条件を追う Issue の URL
- 判定は **行を外した一時プロジェクトで `yarn up -R <probe.up> --mode=update-lockfile` が通るか**で行う。素の `yarn install` では判定できない（後述）
- 結果は 3 つに分ける。解除可能 = 緑 + 撤去 PR、まだ必要 = 緑で何もしない、機構の故障 = 赤で PR は作らない
- 機構の故障は「解除可能」と区別するため、行を**残した**同じ実行（対照）を先に走らせ、通らなければ probe を実行せず赤にする。
  `probe.up` が `yarn.lock` に実在しない場合も赤にする（`yarn up -R` は一致なしでも exit 0 で終わり、誤報の元になるため。2026-10-03 実測）
- job を 2 つに分ける。`Yarn Resolutions Inventory`（probe）は secret を持たず依存解決だけを行い、
  **外す resolutions の pattern 一覧と「lockfile が変わるか」の真偽値だけ**（`removal.json`）を artifact に出す。
  `Yarn Resolutions Removal PR` は GitHub App のトークンを持つが install は実行せず、pattern を信頼できる checkout の台帳
  （probe 付き）と `package.json` で許可リスト照合し、`package.json`・台帳・PR 本文を自分で生成して PR を作る。
  artifact に他のファイルがある、許可外の pattern がある、余分なフィールドがある場合は拒否して赤にする
- 撤去 PR に `backstage/yarn.lock` は含めない。lockfile が変わる場合は PR 本文に明記し、人が `backstage/` で `yarn install` を
  実行して 1 コミット足す（選択肢 8 の案 A）
- PR 作成のトークンは GitHub App `kmryst-dependency-bot`（App ID 5172713）の installation token を `actions/create-github-app-token` で発行する。
  権限は Contents / Pull requests の Read and write のみ、インストール先は本リポジトリのみ
- 撤去 PR のブランチ名は `dependency-bot/yarn-resolutions-removal` に固定し、再実行しても PR が重複せず既存の PR が更新される
- 実行頻度は週次のまま。`dependency-audit.yml` の schedule を月曜 09:00 JST から **10:30 JST（`30 1 * * 1`）** に移し、
  Dependabot の `/backstage` 週次実行（09:15 JST、job は 09:38 JST ごろ完了）の後に置く
- 新しい job にも既存の Inventory と同じ自リポジトリ限定の条件（`github.repository == 'kmryst/idp-golden-path'`）を付け、
  `workflow_call` で呼ぶ消費側リポジトリには影響させない

運用手順・台帳スキーマ・結果の対処表の正本は
[docs/operations/security-scanning.md](../operations/security-scanning.md) の
「脆弱性以外の resolutions の probe と撤去 PR」節とする。

## 背景

`Yarn Resolutions Inventory` は脆弱性対応の台帳（`scripts/ci/yarn-resolutions.json`）だけを対象に、
resolutions を外して advisory が再出現するかで要否を判定している。脆弱性以外の理由の resolutions は advisory を持たないため、
この判定が使えず、不要になったことを検知する仕組みがなかった。

直近の実例が `"@yarnpkg/core/got": "npm:11.8.2"`（Issue #284 / PR #285）である。`@yarnpkg/core` 4.9.2 が `got` の依存指定を
上流リポジトリ内のパッチファイルへの相対参照のまま公開しており（[berry#7281](https://github.com/yarnpkg/berry/issues/7281)、OPEN）、
`@backstage/cli` 0.36.6 経由で引き込むと依存解決が ENOENT で失敗する。上流の修正版が出れば不要になる回避策だが、
出ても誰も気づかなければ永久に残る。

あわせて通知方式の問題がある。Dependabot ignore の解除を検知する `dependency-unblock-check`（ADR-0013）は
追跡 Issue へのコメントで通知しているが、Issue #146 への UNBLOCKED コメント（2026-09-21）は 11 日間対応されなかった。
Issue コメントによる通知は見落とされる。

## 検討した選択肢

### 1. probe の方法: `yarn up -R <親パッケージ>`（採択） / 素の `yarn install --mode=update-lockfile`

既存の stale 判定と同じく「行を外して `yarn install --mode=update-lockfile`」で判定する案は、実測で**誤報**になった。
main の依存グラフには `@yarnpkg/core` 自体が入っていない（`@backstage/cli` 0.36.5 は引き込まず、0.36.6 以降で引き込む）ため、
行を外しても install は 1 秒で成功し、「解除可能」と誤判定して不要な撤去 PR を作ってしまう。

`yarn up -R @backstage/cli --mode=update-lockfile` は `@backstage/cli` の range を最新に再解決して `@yarnpkg/core` を引き込むため、
回避策が効いている条件をそのまま再現できる（2026-10-03 のローカル実測）。

| 状態 | `yarn install --mode=update-lockfile` | `yarn up -R @backstage/cli --mode=update-lockfile` |
| --- | --- | --- |
| 行を外す | exit 0（1.2 秒）— 誤報 | exit 1、Resolution step で `got@patch:...: ENOENT`（3.6 秒）— まだ必要 |
| 行を残す | 変化なし | exit 0、lock に `@yarnpkg/core` と `got@npm:11.8.2` が入る（10 秒）— 対照として成立 |

台帳に「何を引き込めば回避策が効くか」（`probe.up`）を書かせる設計はこの実測に基づく。
`yarn up -R` は glob も受け付けるが、一致するパッケージが無くても exit 0 で終わる（`yarn up -R no-such-package` で実測）ため、
`probe.up` を素のパッケージ名に限定し、`yarn.lock` に実在することを機構検査で確かめる。

### 2. 機構の故障と「解除可能」の区別: 対照の実行（採択） / エラーメッセージの判別

probe の失敗には「まだ必要（ENOENT）」と「通信障害（ENOTFOUND 等）」の両方があり、エラーメッセージの文字列で判別する案は
Yarn のバージョンや registry の応答で変わるため脆い。代わりに**行を残した同じ実行（対照）**を先に走らせる。
対照が通らなければ、通信障害・registry 障害・回避策自体の破綻のいずれかであり、probe の結果は信用できないので赤にする。
対照が通った上で probe も通れば解除可能、probe だけ失敗すればまだ必要。
ADR-0013 の「機構が壊れていれば probe の結果自体が信用できないため、機構検査に違反がある間は probe を実行しない」と同じ考え方である。

### 3. 通知方式: 撤去 PR の自動作成（採択） / Issue コメント + 赤（ADR-0013 方式）

ADR-0013 は「朗報を赤にする」ことで通知インフラを増やさずに人へ届けたが、Issue コメントの記録は 11 日間放置された。
撤去 PR は通常のレビューの流れ（Dependabot PR と同じ週 1 回のバッチ）に乗り、PR 一覧に残り続ける。
対応は「レビューしてマージする」だけで、人が差分を作る工程がない。

**ADR-0013 との関係**: `dependency-unblock-check` は本 ADR では変えない。共通ワークフローとして他リポジトリから `workflow_call` で
呼ばれており、通知方式の変更が呼び出し側に波及するため、本 Issue で仕組みを実地検証してから後続 Issue で同じ方式に寄せる。

### 4. トークン: GitHub App の installation token（採択） / `GITHUB_TOKEN` / 個人 PAT

`GITHUB_TOKEN` で作った PR では `pull_request` トリガーのワークフローが起動せず、required status checks（PR Policy Check /
Commitlint / Markdown Lint / Gitleaks Secret Scan）が走らないため、撤去 PR がマージ不能になる。個人 PAT は実行者の権限で
PR が作られ、PAT の有効期限管理と権限の広さが問題になる。GitHub App は権限を Contents / Pull requests に絞れ、
インストール先を本リポジトリだけに限定でき、トークンは job 終了時に失効する。

**ADR-0007 との関係**: ADR-0007 は Scaffolder の `publish:github` について「installation token では個人アカウント配下の
新規リポジトリ作成（`POST /user/repos`）が 403 になる」ことを実機で確定し、GitHub App への移行を見送った。
本 ADR の用途は**既存リポジトリへの push と PR 作成**であり、installation token で足りる（本 Issue の実地検証で確認）。
ADR-0007 の結論（Scaffolder は PAT を継続する）は変えない。

`actions/create-github-app-token` v3 は `app-id` 入力を deprecated にし `client-id` を推奨している（`action.yml` の
`deprecationMessage: "Use 'client-id' instead."`）。推奨に従い、App の Client ID を variable `DEPENDENCY_BOT_CLIENT_ID` に登録して
`client-id` で渡す。実装の途中で `app-id`（variable `DEPENDENCY_BOT_APP_ID`）でも検証したが、run ごとに deprecation の warning 注釈が出るため
切り替えた。`DEPENDENCY_BOT_APP_ID` は使われなくなるので、main へのマージ後に削除する。

### 5. job の分割: probe と PR 作成を分ける（採択） / 1 job で完結

`yarn up -R` は未検証の上流パッケージの最新版を毎週引く処理であり、依存解決の過程で任意コードが動く余地を残す。
書き込みトークンと同じ job に置かない。ADR-0013 では「artifact の受け渡しでジョブ構造が複雑になる」として分割を見送ったが、
本 ADR では PR 作成に **Contents: write のトークンが必須**で、ADR-0013 の `issues: write` より影響が大きいため分割する。
PR 作成 job は install を一切実行しない。artifact の中身と信頼境界は選択肢 8 で定める。

### 6. 実行頻度と schedule: 週次のまま 10:30 JST へ移動（採択） / 日次 / Inventory 専用の cron を追加

日次にしても、実際に外れる日（上流のリリース）は変わらず、撤去 PR のレビューは Dependabot と同じ週 1 回の流れに乗る。
増えるのは通信障害などの誤報だけなので週次のままにする。

schedule は `dependency-audit.yml` 全体（Dependency Audit / npm Overrides Inventory を含む）で共有している。
Inventory 専用の cron を 1 本追加して `github.event.schedule` で job を分ける案は、同じワークフローが週 2 回走り、
それぞれ半分の job が skip になる。audit ゲートが Dependabot の後に動いても害はないため、cron を 1 本のまま
`30 1 * * 1`（10:30 JST）へ動かす。10:30 の根拠は Dependabot の `/backstage` job が 09:38 JST ごろに完了していること
（Issue #291 の実測）で、52 分の余裕を取っている。

### 7. 撤去 PR の Issue 参照

PR Policy Check は本文に `Closes/Fixes/Refs #<n>` を必須とする。自動 PR では本機構を導入した Issue #291 を `Refs` し、
解除条件の Issue（上流または自リポジトリ）は台帳の `tracking` から本文の表に転記する。

### 8. artifact の信頼境界: 識別子だけを渡し、lockfile は PR に含めない（案 A を採択）

**発端**: PR #293 の Codex レビューで、「PR 作成 job は artifact のファイルを存在確認して `cp` するだけで、撤去対象以外の変更を
検証していない。probe job 側で artifact の `package.json` に `scripts.postinstall` を混ぜれば、そのまま App 名義の撤去 PR に入り、
PR 上の Backstage CI（`yarn install --immutable`）でそのコードが動く」と指摘された。コードを確認し、事実と認めた。

**脅威モデル**: artifact を改ざんできるのは、同じ run の probe job 内でコードを実行できる者だけである
（artifact の書き込みには run の runtime token が要り、他 job・他 run からは触れない）。probe job でコードが動く経路は次のとおり。

- npm パッケージの lifecycle script: `--mode=update-lockfile` は link step を飛ばすため実行されない
- git 依存の `prepare`（Yarn の GitFetcher が外部プロジェクトを `yarn pack` する）: 実行される。
  2026-10-03 時点の `backstage/yarn.lock` に git / https 由来の依存は **0 件**（`patch:` は 6 件で、パッチ適用はコード実行なし）。
  ただし probe は `yarn up -R` で毎週「上流の最新」を引くため、上流が git 依存を 1 つ加えた時点、またはレジストリ側が侵害された時点でこの経路が開く
- 開いた場合、probe 後に作業ツリーから読む `yarn.lock` や、スクリプト終了後・upload 前に artifact ディレクトリの全ファイルを
  常駐プロセスが書き換えられる。検出手段は無かった

したがって **信頼境界は artifact の境界**に置き、probe job の成果物を PR 作成 job が信用しない設計に直す。

**共通部分（分岐なし）**: artifact から受け取るのは `removal.json`（外す pattern の一覧と `lockfileChanges` の真偽値）だけ。
PR 作成 job は信頼できる checkout の台帳で **probe 付きかつ `package.json` に存在する pattern** だけを許可し、
`package.json`・台帳・PR 本文を自分で生成する。改ざんの最悪ケースは「probe 付きの resolutions を早く外す PR が立つ」に縮み、
人のレビューで止まる。

**`yarn.lock` の扱い（3 案）**:

| 案 | 内容 | 不採用の理由 / 代償 |
| --- | --- | --- |
| **A（採択）** PR に lock を含めない | 撤去 PR は `package.json` と台帳だけを変える。probe job が計測した「lock が変わるか」を本文に載せ、変わる場合は人が `backstage/` で `yarn install` を実行して 1 コミット足す | 代償: lock が変わるケースで人の一手間が要る。`@yarnpkg/core/got` の現状（依存グラフに `@yarnpkg/core` が無い）では lock は変わらず、PR はそのままマージできる |
| B PR 作成 job で lock を作り直す | トークン発行の前に `yarn install --mode=update-lockfile` を実行する | 同じ job 内で未検証の上流コード（git 依存の `prepare`）が動く余地があり、常駐プロセスが後続 step の秘密鍵入力を `/proc` 経由で読める。選択肢 5 の分割の根拠を自ら崩す |
| C artifact の lock を検証して受け入れる | 信頼できる lock との差分が、外した resolutions の対象パッケージとその推移的依存に限られることを検証する | 「正しい差分」の判定が難しく、検証器のバグが抜け道になる。健全性を担保しにくい割に実装・テストが重い |

A を採る理由は、本機構の目的が「気づく」ことであり、lock の自動更新は利便性に過ぎないこと、B は分割の意味を失い、
C は健全性を示しにくいことである。ユーザーが A を選んだ（2026-10-03）。

## 採択理由

- 上流の修正待ちで入れた resolutions の要否を、人の棚卸しを待たずに毎週実測できる。判定方法は実際の回避策（`@yarnpkg/core/got`）で
  「外すと失敗する / 残すと通る」を再現できることを確かめて決めた
- 「解除可能」と「機構の故障」を対照の実行で区別するため、通信障害で不要な撤去 PR が作られることがない
- 撤去 PR はレビューの流れに乗り、Issue コメントのように見落とされない。対応者が差分を作る工程もない
- probe と PR 作成を分けることで、書き込みトークンが依存解決の子プロセスから見える構造を避けている。
  job 間を渡るのは識別子だけで、差分は信頼できる checkout から生成するため、probe job で上流コードが動いても App 名義の PR に任意の変更は入らない
- GitHub App の権限とインストール先を最小にし、トークンは job 単位で失効する

## 影響

- 週次の Dependency Audit は月曜 10:30 JST に移る（旧 09:00 JST）。`Yarn Resolutions Inventory` は probe 2 回と
  lockfile 再解決 1 回が加わる（ローカル実測で計 10〜15 秒。従来の job は 30 秒前後）。`timeout-minutes: 15` を設定する
- 解除可能になった週は `dependency-bot/yarn-resolutions-removal` ブランチから撤去 PR（`chore(deps): 不要になった yarn resolutions を撤去する`、
  `type:chore` / `area:backstage` / `area:ci-cd` / `risk:low` / `cost:none`）が作られる。
  対応は Backstage CI の結果と `tracking` の Issue（上流の修正内容）を確認してマージすること。
  PR 本文に「lock が変わる」と書かれている場合（または Backstage CI が `yarn install --immutable` で赤の場合）は、
  その branch で `backstage/` の `yarn install` を実行して lock を 1 コミット足す（選択肢 8 の案 A の代償）
- 新しい非セキュリティ起因の resolutions を追加するときは、解除条件が上流のリリース待ちなら `probe` と `tracking` を書く
  （手順は security-scanning.md）
- `actions/create-github-app-token` と `peter-evans/create-pull-request` が依存に加わる。Dependabot（github-actions）の更新対象になる
- `docs/operations/github-flow-guardrails.md` の permissions 一覧（2026-08-16 時点の実測）は変わらない。
  新しい job は `permissions: contents: read` のままで、書き込みは App のトークンで行う

### GitHub App の秘密鍵の運用

GitHub App の秘密鍵（RSA）は installation token を発行する JWT の署名鍵で、GitHub 側に有効期限はない。
次のとおり運用する。

| 項目 | 内容 |
| --- | --- |
| 保管場所 | リポジトリ secret `DEPENDENCY_BOT_PRIVATE_KEY`（`.pem` の中身）。ローカルにファイルを残さない（作成時に登録後すぐ削除した） |
| ローテーション頻度 | **1 年に 1 回以上**。NIST SP 800-57 Part 1 Rev. 5 の Table 1 が private signature key の cryptoperiod を 1〜3 年としており、その下限を採る |
| ローテーション手順 | 1. App の Settings → Private keys → Generate a private key で新しい鍵を発行 2. `DEPENDENCY_BOT_PRIVATE_KEY` を新しい鍵で更新 3. `workflow_dispatch` で `Dependency Audit` を実行し `Yarn Resolutions Inventory` が緑であることを確認（PR 作成 job は解除可能が出た週にしか動かないため、トークン発行まで確かめたい場合は検証ブランチで Issue #291 と同じ手順を使う） 4. 古い鍵を App の Settings から削除 |
| 漏洩時 | 1. App の Settings → Private keys で**該当の鍵を即時削除**（その鍵で署名した JWT は無効になる） 2. 新しい鍵を発行して secret を更新 3. Security log と `dependency-bot/*` ブランチ・App 名義の PR / commit を確認し、意図しないものがあれば close / 削除 4. 必要なら App を一時的に Suspend する（Install App → Suspend） |
| 権限の見直し | Contents / Pull requests の Read and write より広げない。`dependency-unblock-check` を同じ方式に寄せる際も、Issue のコメントが不要になるため追加権限は要らない見込み |

## 関連

- [ADR-0007](./0007-scaffolder-github-app-authentication.md) — Scaffolder は PAT を継続する（用途が異なり、本 ADR はその結論を変えない）
- [ADR-0008](./0008-ci-guardrails-as-reusable-workflows-with-tag-pinning.md) — `dependency-audit.yml` は reusable workflow でもある。新しい job は自リポジトリ限定
- [ADR-0013](./0013-dependency-unblock-check.md) — Dependabot ignore の解除を Issue コメント + 赤で通知する。後続 Issue で本 ADR の方式に寄せる
- [docs/operations/security-scanning.md](../operations/security-scanning.md) — 運用正本
- [検証記録 2026-10-03](../operations/verification/2026-10-03-yarn-resolutions-removal-pr/README.md) — 受け入れ条件の 4 ケースの実地検証
- Issue #291 — 本機構の導入
- Issue #284 / PR #285 — `@yarnpkg/core/got` の回避策（最初の probe 対象）
- Issue #146 — UNBLOCKED コメントが見落とされた例
