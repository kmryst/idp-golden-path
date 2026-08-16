# セキュリティスキャン運用

CI で実行するセキュリティスキャン（secret 検出 / 依存関係脆弱性監査 / SAST）の運用の正本です。
severity 閾値・fail/warn ポリシー・検出時の対応フローを変更する場合は、対象 workflow と同じ PR でこのドキュメントを更新します。

required status checks との関係は [branch-protection.md](./branch-protection.md) を参照してください。

## スキャンの全体像と役割分担

| workflow | 検出対象 | 実行タイミング | 検出時の扱い |
| --- | --- | --- | --- |
| [Gitleaks Secret Scan](../../.github/workflows/security-scan.yml) | git 履歴への secret / credential 混入 | PR | fail（required status check） |
| [Dependency Audit](../../.github/workflows/dependency-audit.yml) | `backstage/` と reusable workflow 消費側の依存関係にある既知脆弱性（CVE） | PR / 週次（月曜 09:00 JST）/ 手動 | high 以上で fail、moderate 以下は警告のみ |
| [CodeQL](../../.github/workflows/codeql.yml) | コード起因の脆弱性（SAST） | PR / main push / 週次（月曜 09:00 JST） | Security > Code scanning alerts に集約（CI は解析失敗時のみ fail） |
| [Trivy Image Scan](../../.github/workflows/trivy-image.yml) | コンテナイメージの中身（ベースイメージ由来の OS パッケージ・ランタイム同梱ライブラリ）の既知脆弱性 | 消費側の caller 次第（`workflow_call` 専用） | 既定は非 blocking。Security > Code scanning alerts と Step Summary に集約 |
| [Trivy Config Scan](../../.github/workflows/trivy-config.yml) | IaC（Terraform）と Dockerfile の設定不備（misconfiguration） | PR | 既定は非 blocking。Step Summary + artifact |

5 つのスキャンは検出レイヤーが異なり、相互に代替できません。

- **Gitleaks**: 「自分が書いたもの」に秘密情報が混入していないか（コミット内容の検査）
- **Dependency Audit**: 「他人が書いたもの（依存パッケージ）」に既知の脆弱性がないか（サプライチェーンの検査）
- **CodeQL**: 「自分が書いたもの」に脆弱なコードパターンがないか（静的解析）
- **Trivy Image Scan**: 「アプリを載せる土台」に既知の脆弱性がないか（実行イメージの検査）
- **Trivy Config Scan**: 「まだ動いていない設定ファイル」の書き方が危険でないか（IaC の検査）

Dependency Audit と Trivy Image Scan は特に混同しやすいですが、対象が重なりません。
Dependency Audit（および Dependabot alerts）はアプリの lockfile が宣言する依存しか見ないため、
ベースイメージの OS パッケージや、Node 公式イメージ同梱の npm 自身の依存
（`/usr/local/lib/node_modules/npm/node_modules/` 配下）は原理的に対象外です。
ticket-c2c-platform の実測では、image scan の 29 件（`CRITICAL,HIGH`）はすべてベースイメージ由来で、
うち 7 件がこの npm 同梱依存でした。

なお Dependabot version updates（`.github/dependabot.yml`）は「新しいバージョンが出たら更新 PR を作る」仕組みであり、
既知脆弱性（CVE）の検出・警告は Dependency Audit が担います。
`.github/dependabot.yml` の `ignore`（上流の非互換で止めているメジャー更新）の解除条件を週次で実測検証する仕組みは別立てで、
正本は [dependency-unblock-check.md](./dependency-unblock-check.md) です。
Dependabot 自体の状態をどこから読むか（run ログ・alerts API・Dependency graph の使い分け）は
後述の「[Dependabot の観測面](#dependabot-の観測面)」節にまとめています。

## Dependency Audit

- 本リポジトリの対象: `backstage/`（Yarn workspaces）。ルートの npm 依存（lint ツール類）は Dependabot の更新で追従する
- reusable workflow 消費側の対象: `package-manager`（npm / Yarn）と `working-directory` input で指定された依存グラフ
- 本リポジトリのコマンド: `yarn npm audit --all --recursive`（全 workspace + 推移的依存を監査）
- schedule 実行があるため、PR が無い期間に公開された新規 CVE も週次で検出できる

### severity 閾値と fail/warn ポリシー

| severity | 扱い |
| --- | --- |
| critical / high | CI fail（`--severity high` ゲート） |
| moderate / low / info | fail させない。全 severity の監査結果を Step Summary に出力して可視化のみ |

moderate 以下を fail させないのは、Backstage 本体の依存グラフが大きく、
修正版が上流に存在しない低 severity の検出で PR が恒常的にブロックされるのを避けるためです。

### 検出時の対応フロー

1. Step Summary で該当 advisory（パッケージ名・severity・修正版の有無）を確認する
2. 修正版がある場合: 依存の更新で解消する
   - 直接依存: `backstage/package.json` のバージョン更新（Dependabot PR があればそれを優先）
   - 推移的依存で、宣言 range 内に修正版がある場合: `yarn install` による lockfile の更新だけで解消する。
     `resolutions` は追加しない（fresh resolve で修正版が選ばれるなら固定は不要であり、上流更新の足止めになる）
   - 推移的依存で、依存元が脆弱バージョンを exact pin している等、再解決しても修正版が選ばれない場合に限り:
     `backstage/package.json` の `resolutions` を追加する（後述の運用ルールに従う）
3. 修正版が無い / 即時対応できない場合（例外運用）:
   - Issue を起票して、除外理由・期限・削除条件を追跡する
   - 本リポジトリ（Yarn）は、後述の `scripts/ci/yarn-audit-exceptions.json` へ期限付き GHSA を登録する
   - npm の reusable workflow 消費側は、後述の `npm-audit-exceptions` input へ期限付き GHSA を設定する
   - yarn の reusable workflow 消費側は、後述の `yarn-audit-exceptions` input へ期限付き GHSA を設定する
   - 除外は恒久化させず、修正版リリース後に除外を外す PR を作る
4. schedule 実行での検出（PR 起因でない新規 CVE）も同じフローで、Issue 起票から始める

### npm reusable workflow の期限付き例外

`npm-audit-exceptions` は、npm に advisory 除外オプションがないことを補う reusable workflow input です。
既定値は空の JSON 配列 `[]` で、未指定時は full audit の High / Critical をすべて fail させます。
caller の `NODE_ENV` / npm config に左右されないよう、full audit は prod / dev / optional / peer を明示的に include します。
監査対象は `package-lock.json` に固定し、caller の npm config で lockfile を無効化できないようにします。
空の例外を明示する場合は、表記ゆれを避けて正確に `[]` を指定します。

例外を使う場合は、次の形式で正確な GHSA ID、有効期限、追跡 Issue を宣言します。

```yaml
with:
  package-manager: npm
  npm-audit-exceptions: >-
    [{"id":"GHSA-xxxx-xxxx-xxxx",
      "expires":"2026-10-26",
      "tracking":"https://github.com/OWNER/REPO/issues/123"}]
```

- `expires` は UTC の日付で、記載日までは有効。設定日から最大 90 日とし、期限切れ、上限超過、書式不正、重複 ID、未知フィールドは fail する
- 例外を適用する前に dev だけを omit し、prod / optional / peer を明示的に include した runtime audit を実行する
- full audit では、`via` 連鎖の根本原因が期限内の完全一致した GHSA だけである High を一時許可する
- Critical、未許可の High、根本 advisory を解決できない結果、audit JSON / registry の異常は fail closed にする
- 例外登録済み GHSA が検出されなくなった場合は、依存修正 PR をブロックせず Job Summary で削除を促す
- Job Summary には GHSA、現在の severity、影響パッケージ、期限、追跡 Issue、使用状態を記録する

Yarn 4 の `--ignore` は npm registry の数値 advisory ID を照合するため、GHSA を受け取るこの input の対象外です。
Yarn と組み合わせて `npm-audit-exceptions` を設定した場合は、設定ミスとして fail します。
Yarn の一時例外は次節の `yarn-audit-exceptions` / `scripts/ci/yarn-audit-exceptions.json` で扱います。

### yarn の期限付き例外

yarn パスの期限付き例外は `scripts/ci/yarn-audit-policy.mjs` が評価します。
例外の宣言方法は実行元によって異なりますが、スキーマと制約は npm 側と同一です
（完全一致する GHSA ID、UTC の `expires`、GitHub Issue の `tracking` を必須とし、
有効期間は評価時点から最大 90 日。期限切れ、上限超過、書式不正、重複 ID、未知フィールドは fail）。

| 実行元 | 例外の宣言場所 |
| --- | --- |
| 本リポジトリ自身（PR / 週次 / 手動） | `scripts/ci/yarn-audit-exceptions.json`（リポジトリ内ファイル） |
| yarn の reusable workflow 消費側 | `yarn-audit-exceptions` input（npm 側と同じ JSON 配列形式） |

- 例外が 1 件も無い場合は従来どおり `yarn npm audit --all --recursive --severity high` の素のゲートを実行する（消費側の既定挙動は不変）
- 例外がある場合は評価器が `yarn npm audit --all --recursive --json` の NDJSON を直接評価し、
  期限内の完全一致した GHSA に起因する High だけを一時許可する
- Critical、未許可の High、GHSA ID を持たない advisory、audit 出力の異常は fail closed にする
- npm 側と異なり、runtime 依存だけを事前監査する別ゲートは持たない。Yarn workspaces のモノレポでは
  フロントエンド実行時依存も production に分類され、npm 側の「開発依存のみ例外可」という境界として
  機能しないため、ガードは severity（Critical 例外不可）・期限・追跡 Issue に一本化する
- 例外登録済み GHSA が検出されなくなった場合は fail させず、Job Summary で削除を促す
- Job Summary には GHSA、severity、影響パッケージ、期限、追跡 Issue、使用状態を記録する
- 評価器は `scripts/ci/yarn-audit-policy.test.mjs`（npm 側と同水準のユニットテスト）で担保し、
  本リポジトリの Dependency Audit 実行時に毎回テストする

### セキュリティ起因の yarn resolutions の運用

期限付き例外が「脆弱性が残ったまま期限付きで受容する」機構であるのに対し、`resolutions` は
「修正版を強制して脆弱性を消す」機構です。ただし resolutions も放置すれば上流更新の足止めという
負債になるため、例外と同水準の台帳・棚卸しで管理します。期限（expires）は持たせません。
resolutions は「その行を外して依存解決し直せば、まだ必要かどうかを実測で判定できる」ため、
任意の日付より正確な削除条件を機械判定できるからです。

**追加基準**（すべて満たす場合のみ追加する）:

1. 対象 advisory の修正版が、依存元の宣言 range と同一 major 内に存在する
2. resolutions なしで再解決しても修正版が選ばれない（依存元が脆弱バージョンを exact pin している等）。
   宣言 range 内で fresh resolve が修正版を選ぶ場合は、lockfile の更新（`yarn install`）だけで解消し
   resolutions を追加しない
3. 適用後に `yarn install` / `yarn test` / `yarn tsc` / `yarn build:all` の成功を実測確認する。
   通らない場合は resolutions を諦め、期限付き例外に回す

**書き方**:

- キーは依存元が宣言している range 単位（例: `undici@npm:7.28.0`）で指定し、bare なパッケージ名
  （全 range に適用）は major 混在時の巻き込みを避けるため使わない
- 右辺は修正版を下限とする range（例: `^7.29.0`）にする。再現性の固定は lockfile の仕事であり、
  右辺を完全固定すると同系統の次の修正版を拾えない

**台帳（サイドカー）**: `package.json` にはコメントを書けないため、セキュリティ起因の resolutions は
`scripts/ci/yarn-resolutions.json` に理由・対応 GHSA・経路（dependents）を必ず登録する。
`scripts/ci/yarn-resolutions-audit.mjs` が次の 2 つを検証する
（ユニットテストは `scripts/ci/yarn-resolutions-audit.test.mjs`）。

| チェック | 実行タイミング | 内容 |
| --- | --- | --- |
| sync | 毎回（PR / 週次 / 手動） | 台帳のスキーマ検証と、`backstage/package.json` の resolutions との同期（欠落・右辺不一致で fail） |
| stale（棚卸し） | 週次 schedule / 手動 | 台帳の resolutions を全部外した一時プロジェクトで lockfile を再解決（`yarn install --mode=update-lockfile`、作業ツリーは汚さない）して audit を実行し、台帳記載の advisory が再出現するかを実測する |

**削除条件**: stale チェックで advisory が再出現しなかった resolution は不要になっているため **fail** する
（期限切れ例外と違い「該当行と台帳エントリを消すだけ」で対応コストが低く、放置する理由がないため
warn ではなく fail とする）。検出されたら resolutions の該当行と台帳エントリを削除する PR を作る。
棚卸しを毎 PR ではなく週次にするのは、判定材料（上流のリリース）が週次でしか変わらず、
依存グラフ全体の再解決コストを毎 PR で払う価値がないため。台帳未記載の High / Critical が
管理対象パッケージに再出現した場合は警告に留める（実グラフの週次 audit ゲートが本監視を担う）。

## Dependabot の観測面

Dependabot は本リポジトリの workflow ではなく GitHub のマネージドサービスなので、
「今どうなっているか」を見る経路が上の 5 スキャンとは別建てになります。
経路ごとに取れる情報が違い、**どれか 1 つだけでは状況が分かりません**。

| 経路 | URL / コマンド | 取れるもの | 取れないもの |
| --- | --- | --- | --- |
| Actions タブ | `https://github.com/kmryst/idp-golden-path/actions/workflows/dependabot/dependabot-updates`<br>`gh run list --workflow="Dependabot Updates"` | run の成功 / 失敗、対象ディレクトリとパッケージ（`displayTitle`） | 失敗理由 |
| Dependency graph > Dependabot | `https://github.com/kmryst/idp-golden-path/network/updates` | 失敗理由（UI 上）、`Check for updates` ボタン | — |
| Security タブ / alerts API | `https://github.com/kmryst/idp-golden-path/security/dependabot`<br>`gh api repos/kmryst/idp-golden-path/dependabot/alerts` | alert 一覧・`security_advisory.severity` / `ghsa_id`・`security_vulnerability.first_patched_version`・`dependency.manifest_path` | **「なぜ更新 PR が作れなかったか」を示すフィールドは無い** |

`displayTitle` に `for <パッケージ名>` が入っている run が security update、入っていない run が version update です
（例: `npm_and_yarn in /backstage for uuid - Update #...` は security update）。

### `gh run view --log` は静かに 0 バイトを返すことがある

**Dependabot Updates の run に対する `gh run view <id> --log` は、run によって 0 バイトを返します。
しかも exit code は 0 のままで、失敗として検知できません。**

2026-08-16 の実測（idp-golden-path、4 run）:

| run | `gh run view --log` | exit | 種別 | conclusion |
| --- | --- | --- | --- | --- |
| 31927306462 | **0 bytes** | 0 | security update（`for uuid`） | failure |
| 31929840013 | 46,280 bytes | 0 | security update（`for js-yaml`） | success |
| 31929125387 | **0 bytes** | 0 | version update（skeleton） | success |
| 31929125311 | 469,054 bytes | 0 | version update（`/backstage`） | failure |

**発生条件は未特定です。** security / version の別でも、成功 / 失敗の別でも、実行時刻でも説明がつきません
（31929125387 と 31929125311 はいずれも 2026-08-16 05:29 の run）。
job / step 構成は 4 run とも同一（`Dependabot` ジョブ 1 本、step 5 つ、番号・名前まで一致）で、
ログ zip の内部構成も同一（`0_Dependabot.txt` + `Dependabot/system.txt`）です。
0 バイトになる run は 3 回試行しても決定的に 0 バイトで、`--job <job-id>` を指定しても 0 バイトでした。

したがって、次のような書き方は**偽陰性**になるため使いません。

```bash
# NG: 「ログが取れなかった」と「該当文字列が無かった」を区別できない
gh run view "$rid" --log | grep -q "security_update_not_possible"
```

**確実な経路は API です。** `gh api repos/<owner>/<repo>/actions/runs/<id>/logs` は
上記 4 run すべてで HTTP 200 と実体のある zip を返しました（`0_Dependabot.txt` は 36,600 / 38,201 / 79,099 / 416,671 バイト）。

```bash
gh api repos/kmryst/idp-golden-path/actions/runs/<run-id>/logs > log.zip
unzip -p log.zip 0_Dependabot.txt
```

### `security_update_not_possible` はログからしか読めない

security update の run が失敗したとき、その理由はログ末尾の `Errors` 表に構造化されて出ます。
alerts API には対応するフィールドがありません。

```text
INFO <job_1526721114> Requirements to unlock update_not_possible
INFO <job_1526721114> Requirements update strategy bump_versions
+------------------------------+----------------------------------------------+
| Type                         | Details                                      |
+------------------------------+----------------------------------------------+
| security_update_not_possible | {                                            |
|                              |   "dependency-name": "uuid",                 |
|                              |   "latest-resolvable-version": "3.4.0",      |
|                              |   "lowest-non-vulnerable-version": "14.0.0", |
|                              |   "conflicting-dependencies": []             |
|                              | }                                            |
+------------------------------+----------------------------------------------+
```

`latest-resolvable-version`（依存グラフ上で解決できる最新）と
`lowest-non-vulnerable-version`（脆弱でなくなる最小）の差が、「なぜ上げられないか」を直接示します。
上の実測（run 31927306462）では 3.4.0 と 14.0.0 の間に 10 メジャーの開きがあり、
Dependabot 単体では手が出ないことが読み取れます。この場合は
「Dependency Audit > 検出時の対応フロー」の 3（例外運用）か、依存元ごと更新する PR で対応します。

### このログを恒常的な判定材料にしない

- **ログの書式は非公式で、GitHub からの互換性の保証はありません。** 表組みも `INFO` 行の文言も
  Dependabot の実装都合で変わり得ます。CI の合否をこの文字列一致に依存させないでください
- **Actions のログには保持期間があり、期限を過ぎた run のログは取得できなくなります。**
  過去に遡って集計する用途には使えません

以上から、この節の手順は「詰まったときに理由を調べる調査手順」として使い、
機械判定は [dependency-unblock-check.md](./dependency-unblock-check.md) の評価器のように
リポジトリ内のファイルを正本とする仕組みで行います。

## CodeQL

- 解析言語: `javascript-typescript`（Backstage アプリ本体）と `actions`（GitHub Actions workflow）。build-mode は `none`（ビルド不要のスキャン）
- public リポジトリのため CodeQL は無料で利用できる
- リポジトリ側の CodeQL default setup は使わず、この workflow（advanced setup）を正本とする。default setup を有効化すると衝突するため併用しない

### 検出時の対応フロー

1. Security > Code scanning alerts で該当 alert（ルール ID・該当箇所・severity）を確認する
2. 原則としてコード修正で解消する
3. false positive の場合: alert を Dismiss し、理由（False positive / Used in tests / Won't fix）を必ず選択する
4. alert の存在自体は PR をブロックしない（後述）。critical / high の alert は Issue を起票して追跡する

## Trivy Image Scan

コンテナイメージをビルドして（`docker build` のみ。push はしない）、その中身を Trivy でスキャンします。
設計判断は [ADR 0008 追記 2026-08-11](../adr/0008-ci-guardrails-as-reusable-workflows-with-tag-pinning.md) を参照してください。

**本リポジトリの `pull_request` では起動しません。** `workflow_call` 専用です。
本リポジトリの Dockerfile はビルド前にホスト側で `yarn install --immutable` / `yarn tsc` / `yarn build:backend`
を実行しておく必要があり、素の「checkout → docker build」に乗らないためです。
その代わり、reusable workflow 自身の回帰は
[Trivy Image Scan Selftest](../../.github/workflows/trivy-image-selftest.yml) が検知します
（最小フィクスチャ `scripts/ci/fixtures/trivy-image/{primary,secondary}/Dockerfile` をビルドして scan する薄い caller。
`trivy-image.yml` 本体・caller・フィクスチャを触った PR でのみ実行）。

### inputs

| input | 必須 | 既定 | 用途 |
| --- | --- | --- | --- |
| `image-name` | **はい** | — | ローカルタグ名兼 SARIF category の識別子（例: `backend` / `frontend`）。`^[a-z0-9][a-z0-9._-]*$` |
| `docker-context` | いいえ | `.` | build context |
| `dockerfile` | いいえ | `<docker-context>/Dockerfile` | Dockerfile のリポジトリルートからの相対パス |
| `severity` | いいえ | `CRITICAL,HIGH` | 検出対象 severity |
| `exit-code` | いいえ | `'0'` | `'1'` にすると finding 検出時に job を fail させる |
| `upload-sarif` | いいえ | `true` | SARIF を Security > Code scanning alerts へ送るか |
| `trivy-version` | いいえ | `v0.70.0` | 使用する Trivy のバージョン |

`upload-sarif` は省略して呼ぶのが標準の使い方です。SARIF を上げたくない場合だけ明示的に `false` を渡します。
この既定値は `trivy-image.yml` の input 宣言（`default: true`）が正本で、
宣言漏れは selftest の `Workflow Input Contract` job が全 PR で検査します
（宣言が無いと boolean input は未指定時に `false` に評価され、SARIF が黙って上がらなくなります。
実際に発生した事象と対策は ADR-0008 追記 2026-08-12 を参照）。

### 消費側からの呼び出し方

```yaml
jobs:
  # caller job には name: を付けない（check 名は `backend / Trivy Image Scan` になる）
  backend:
    permissions:
      contents: read
      # upload-sarif: false で呼ぶ場合も必須。付与しないと run 全体が失敗する
      security-events: write
    uses: kmryst/idp-golden-path/.github/workflows/trivy-image.yml@v1
    with:
      image-name: backend
      dockerfile: Dockerfile

  frontend:
    permissions:
      contents: read
      security-events: write
    uses: kmryst/idp-golden-path/.github/workflows/trivy-image.yml@v1
    with:
      # backend と同じ値にすると SARIF の category が衝突し、片方の alert が消える
      image-name: frontend
      dockerfile: frontend/Dockerfile
```

- **`image-name` はイメージごとに必ず変えます。** SARIF は `category: trivy-image-<image-name>` で
  アップロードされ、category が同じだと後の upload が前を上書きして先に上げた側の alert が消えます
- caller 側の `concurrency` group には `-caller` サフィックスを付けます。
  `trivy-image.yml` 自身は workflow レベルの concurrency を持ちません
  （複数イメージの並行 scan が通常の使い方であり、callee 側に group を置くと相互キャンセルするため）

### 検出時の対応フロー

1. Step Summary で件数・severity 内訳・修正版の有無を確認する（`修正版なし` の件数が重要）
2. 修正版がある finding は、ベースイメージの更新（`FROM` の tag / digest 更新）で解消する。
   アプリ依存に起因する場合は Dependency Audit のフローに合流する
3. 修正版がない finding（`affected` / `fix_deferred` / `will_not_fix`）は、ベースイメージを最新にしても消えない。
   代替ベースイメージ（distroless 等）への移行を検討する材料として扱い、個別の追跡はしない
4. critical / high が新規に増えた場合は Issue を起票して追跡する

## Trivy Config Scan

Terraform / Dockerfile などの設定不備を review signal として検出します（`trivy config`）。
本リポジトリでは PR ごとに実行し、他リポジトリからは `workflow_call` で呼び出します（dual-trigger）。

### inputs

| input | 必須 | 既定 | 用途 |
| --- | --- | --- | --- |
| `scan-ref` | いいえ | `.` | スキャン対象のリポジトリ相対パス |
| `severity` | いいえ | `HIGH,CRITICAL` | 検出対象 severity |
| `exit-code` | いいえ | `'0'` | `'1'` にすると finding 検出時に job を fail させる |
| `skip-dirs` | いいえ | （除外なし） | 走査から除外するディレクトリのカンマ区切りリスト |

`scanners` input は提供しません。`trivy config` サブコマンドは `--scanners` を持たず、
`trivy-action` が渡す `TRIVY_SCANNERS` を束縛しないため、指定しても no-op だからです（実測）。

### 消費側からの呼び出し方

```yaml
jobs:
  trivy-config:
    permissions:
      contents: read
    uses: kmryst/idp-golden-path/.github/workflows/trivy-config.yml@v1
    with:
      skip-dirs: docs/worklogs,client/dist
```

caller 側の `concurrency` group は `trivy-config-caller-<PR番号>` のように callee と区別します。

### 検出時の対応フロー

1. Step Summary のルール別集計で、件数の多いルール（同じ指摘の横展開）から見る
2. 設定として直せるものは Terraform / Dockerfile を修正する
3. 意図して受容するもの（例: 検証環境で WAF を無効にしている）は accepted risk として ADR / 運用ドキュメントに記録する
4. 分類が済むまでは非 blocking のまま運用する

## exit-code 方針（blocking 化を保留している理由）

Trivy Image Scan / Trivy Config Scan はどちらも既定 `exit-code: '0'` の **非 blocking** です。

- image: 検出の大半が修正不能である。ticket-c2c-platform の実測では 29 件中 22 件が
  `affected` / `fix_deferred` / `will_not_fix` で、`exit-code: 1` にするとベースイメージを最新にしても
  恒久的に fail する。常時 fail するゲートは alert fatigue で検知能力を失う
- config: finding が未棚卸しで accepted risk 候補を含む（本リポジトリで 10 件、ticket-c2c-platform で 41 件）

blocking 化（`exit-code: '1'` / required status check 昇格）は、finding の分類と accepted risk の記録を
終えてから別 Issue で判断します。`exit-code` は input なので、棚卸しの済んだ消費側は caller の 1 行変更で切り替えられます。

## required status checks との関係

現時点では Dependency Audit / CodeQL / Trivy Config Scan / Trivy Image Scan Selftest を
required status checks に**昇格させません**
（[branch-protection.md](./branch-protection.md) の required checks は従来どおり）。

- Dependency Audit の fail 要因（新規公開 CVE）は PR の変更内容と無関係に発生するため、
  required にすると無関係な PR が突然マージ不能になる。まず非 required で運用し、検出頻度を見てから昇格を判断する
- CodeQL は alert 集約型で、PR ブロックには branch protection 側の Code scanning 設定が別途必要。こちらも運用実績を見てから判断する
- Trivy Config Scan は既定が非 blocking（`exit-code: '0'`）で、finding が未棚卸しのため昇格させない
- Trivy Image Scan Selftest は paths filter 付きで実行されるため、required にすると
  filter に一致しない PR で check run が作成されず、required check が永久に pending になる
  （`Backstage CI` と同じ理由。[branch-protection.md](./branch-protection.md) 参照）

昇格する場合は別 Issue で扱い、`branch-protection.md` の設定変更と同じ PR でこのドキュメントを更新します。
