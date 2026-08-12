# 0008. CI ガードレールを reusable workflows として提供し、タグ固定（`@v1`）で参照する

## ステータス

Accepted

## 日付

2026-07-08

## 決定内容

CI ガードレール一式（PR Policy Check / Commitlint / Markdown Lint / Gitleaks Secret Scan / Sync Labels / Issue Template Check）の正本を、本リポジトリ `.github/workflows/` の GitHub Actions **reusable workflows** として提供する。

- 本リポジトリの各 workflow は `pull_request`（または `push` / `workflow_dispatch`）と `workflow_call` の**両トリガー**を持つ。本リポジトリ自身の CI と、他リポジトリから呼び出される reusable workflow を同一ファイルで兼ねる（dual-trigger 方式）
- 消費側（Scaffolder skeleton が生成するリポジトリ、terraform-hannibal、ticket-c2c-platform）は、トリガー・permissions・concurrency だけを持つ薄い caller workflow から `uses: kmryst/idp-golden-path/.github/workflows/<file>.yml@v1` で参照する
- 参照のバージョニングは **タグ固定**とする。`@main` 追従は採用しない
  - immutable なリリースタグ `v1.0.0`, `v1.1.0`, ... を打ち、あわせて major を指す移動タグ `v1` を最新の `v1.x.y` に付け替える（GitHub Actions 公式アクションと同じ規約）
  - 消費側は原則 `@v1`（移動 major タグ）を参照する
- リポジトリごとの差異は reusable workflow の inputs で吸収する
  - `pr-policy-check.yml`: `strict-paths-regex`（厳密運用 path 判定。既定値 `^(\.github/workflows/|scripts/github/|terraform/)`）
  - `markdown-lint.yml` / `pr-commitlint.yml`: `node-version`（既定値 24）
  - `security-scan.yml`: `gitleaks-version`（既定値 8.30.1）
  - `issue-template-check.yml`: inputs なし（必須見出し・ラベル prefix は 3 リポジトリ共通規約のためハードコード）
- reusable workflows は呼び出し側リポジトリを checkout して動作するため、本リポジトリのローカル composite action（`setup-node-npm`）への依存は廃止し、セットアップ手順は各 workflow にインライン化する

### リリース手順（タグ運用）

reusable workflows を変更する PR がマージされたら、次の手順でタグを更新する。

```bash
git switch main && git pull --ff-only origin main
git tag v1.x.y            # immutable なリリースタグ（semver で採番）
git tag -f v1             # 移動 major タグを最新に付け替える
git push origin v1.x.y
git push origin v1 --force
```

破壊的変更（inputs の非互換変更、check run 名の変更、消費側リポジトリへの新たな前提の追加）は `v2` として採番し、`v1` は付け替えない。消費側は Dependabot（`package-ecosystem: github-actions`）が `uses:` 参照の major バージョンアップを PR として提案する。

## 背景

terraform-hannibal / ticket-c2c-platform で確立した CI ガードレールを本リポジトリと Scaffolder skeleton に移植した結果、同一ロジックのコピーが 3 リポジトリ + skeleton に分散し、修正のたびに手動で同期する運用になっていた。実際に pr-policy-check のリトライ処理や厳密運用 path はリポジトリ間で乖離しており、更新の取りこぼしが構造的に発生し得る（Issue #39、DevOps/SRE/Platform Engineering レビュー指摘 2026-07-07）。

ゴールデンパスの価値は「ガードレールの一括提供」だけでなく「提供後も陳腐化しないこと」にあり、生成したリポジトリが参照だけでプラットフォーム側の改善を取り込めるようにする必要がある。

## 検討した選択肢

1. **コピー運用の継続 + 乖離検知 CI**: skeleton と本体のファイル diff を CI で検出する。乖離を「検知」はできるが「解消」は依然手動で、3 リポジトリ横断の同期コストは残る
2. **composite actions のみへの切り出し**: steps 部分だけを共通化する。check run 名が変わらないため消費側の branch protection 変更が不要という利点があるが、トリガー・permissions・concurrency・Dependabot スキップ条件などの骨格は各リポジトリにコピーされたまま残り、乖離の温床が解消しない
3. **reusable workflows への切り出し（採択）**: workflow 全体（トリガー条件を除く）を単一のソースオブトゥルースにする。消費側は薄い caller のみ
4. 参照方式について: **`@main` 追従** / **SHA pin** / **タグ固定（採択）**

## 採択理由

- reusable workflows はジョブ構造・permissions・スキップ条件・チェックロジックまで含めて一元化でき、乖離を構造的に解消する本命である（選択肢 1, 2 との比較）
- dual-trigger 方式により、本リポジトリでは caller と reusable の二重ファイルを持たず、既存の check run 名（`PR Policy Check` 等）と branch protection 設定を**変更せずに**済む
- `@main` 追従は、本リポジトリへの変更が消費側の本番 CI に無審査で即時反映されるサプライチェーンリスクがあり不採択。GitHub 自身も reusable workflows / actions の参照はブランチではなくタグ / SHA への pin を推奨している
- SHA pin は改ざん耐性が最も高いが、同一オーナー（kmryst）配下の first-party workflow に対しては過剰であり、更新追従の運用コストが高い。タグ固定（`@v1`）なら Dependabot のバージョンアップ PR で更新の取りこぼしを緩和でき、major タグを付け替えない限り破壊的変更が黙って流入しない

## 影響

- 消費側リポジトリでは check run 名が `<caller job name> / <called job name>` の合成名になるため、branch protection の required status checks をこの名称で設定する必要がある（具体的な命名例は 2026-07-13 追記を参照。caller job 名は callee と同名にせず job id にフォールバックさせることを推奨する）。skeleton の `docs/operations/branch-protection.md` は更新済み。terraform-hannibal / ticket-c2c-platform は移行 PR で各リポジトリの branch protection と設定記録ドキュメントを同時に更新する
- 本リポジトリの required status checks（`PR Policy Check` / `Commitlint` / `Markdown Lint` / `Gitleaks Secret Scan`）は dual-trigger 方式のため**変更不要**
- 消費側の前提条件: `lint:md` / `commitlint` の npm scripts と設定ファイル、`.github/labels.yml`、`scripts/github/sync-labels.sh`（Sync Labels を使う場合）が呼び出し側リポジトリに存在すること。skeleton 生成リポジトリはすべて満たす。Issue Template Check は GitHub API のみで動作する（呼び出し側の checkout・ローカルファイル不要）ため、`issues` イベント（opened / edited / labeled / unlabeled）で呼び出すこと以外の前提はない
- Issue Template Check は `issues` イベント駆動で PR の check run にはならないため、branch protection の required status checks には影響しない
- `.github/actions/setup-node-npm`（本体・skeleton とも）は廃止。セットアップ手順は各 reusable workflow にインライン化
- 本リポジトリの workflow の job name・inputs・check run 名は消費側との互換性契約になる。変更する場合は semver（major タグ）で管理する
- terraform-hannibal / ticket-c2c-platform の移行は、本 ADR を含む PR のマージと `v1` タグ作成の**後**でなければ CI が成立しない（`@v1` 参照が解決できない）。移行は各リポジトリの Issue / PR として別途進める

## 追記（2026-07-08）

Issue Template Check（Issue 本文の必須見出し `目的` / `対象` / `受け入れ条件` と必須 4 ラベルの検証・フォーム回答からのラベル自動補正・不備コメント投稿）を共通ガードレールの 6 種目として追加した（Issue #46）。

これは terraform-hannibal にのみ先行実装されていた workflow の正本化であり、内容は 3 リポジトリ共通の CLAUDE.md / CONTRIBUTING.md 運用（Issue テンプレートの必須見出し・必須 4 ラベル）の検証そのものでリポジトリ固有の要素を持たないため、本 ADR の決定（dual-trigger 方式・タグ固定参照）をそのまま適用する。新しい設計判断は伴わない。terraform-hannibal 側の caller への置き換えは、他 4 種と同様に各リポジトリの移行 Issue / PR として別途進める。

## 追記（2026-07-13）: caller/callee の concurrency group 名衝突によるデッドロックと check 名重複の修正

ticket-c2c-platform の Commitlint 移行（ticket-c2c-platform#294 / PR #299）で、本 ADR の設計に構造的な欠陥があることが実測で判明した。

### 判明した問題

1. **concurrency デッドロック**: caller workflow（消費側リポジトリ）と callee（本リポジトリの reusable workflow）が同一の `concurrency.group` 文字列を使うと、GitHub Actions は workflow_call 経由でも caller/callee 双方の concurrency group を評価するため、「caller と callee 間のデッドロック」と判定し、job を1つも起動せず run をキャンセルする。`issue-template-check.yml` には当時「workflow_call 経由の場合、reusable workflow 側の workflow レベル concurrency は適用されない」という誤った前提のコメントがあり、これが `service-baseline` skeleton の caller 例で caller/callee に同一の group 名を与えた設計判断の根拠になっていたと考えられる。実際には両方が評価されるため、同一名は本質的にデッドロックを引き起こす。
2. **check 名の重複表示**: caller job と callee job が同名（例: 双方とも `Commitlint`）だと、reusable workflow 経由の check 名は `<caller job name> / <callee job name>` の合成名になり、`Commitlint / Commitlint` のような文字列がそのまま重複した表示になる。これはコピペミスに見え、required status checks 一覧の可読性を損なう。

### 対応

- 本リポジトリの reusable workflow 本体（`pr-policy-check.yml` / `pr-commitlint.yml` / `security-scan.yml` / `markdown-lint.yml` / `issue-template-check.yml`）の `concurrency` block に、caller 側が同一 group 名を使ってはならない旨の契約コメントを追加した（機能変更なし）
- `issue-template-check.yml` の誤った前提コメントを訂正した
- `backstage/templates/service-baseline/skeleton/.github/workflows/` 配下の caller workflow 例を修正した
  - concurrency group 名に `-caller` サフィックスを付け、callee 側と衝突しないようにする（例: `commitlint-caller-<PR番号>`）
  - caller job には `name:` を付けず、job id にフォールバックさせることで check 名の完全重複を避ける（例: `commitlint / Commitlint`）
- 本追記は ADR-0008 の決定（reusable workflow 化・タグ固定参照・dual-trigger 方式）自体を変更するものではなく、消費側の呼び出し方（usage contract）の誤りを正すものである

### 消費側への影響

- 本リポジトリの `.github/workflows/*.yml` への変更はコメント追加のみで、inputs・permissions・job 構造・check run 名は変わらない。ADR-0008 の semver ポリシー上、破壊的変更ではないため `v1.x.y` の patch/minor リリースとして扱い、`v1` タグを進める
- 既に `@v1` を参照している消費側（ticket-c2c-platform）は、コメントのみの変更のため次回 CI 実行時に自動で新しい内容を参照するが、動作への影響はない
- `backstage/templates/service-baseline/skeleton/` の修正は、今後 Scaffolder で新規生成されるリポジトリにのみ影響する。既存の生成済みリポジトリには影響しない
- ticket-c2c-platform は本問題を独自に発見し、`-caller` サフィックス・job id フォールバックの回避策を先行して適用済み（PR #299〜#302）。本追記はその回避策を idp-golden-path 側の正本・skeleton へ機械的に反映したものであり、新たな設計判断は伴わない
- terraform-hannibal 側の同種移行（未着手）は、本追記後の skeleton パターンをそのまま踏襲する

### 関連

- Issue: [kmryst/idp-golden-path#106](https://github.com/kmryst/idp-golden-path/issues/106)
- ticket-c2c-platform#294（Commitlint 移行、デッドロックを実測）、PR #299〜#302

## 追記（2026-07-13）: CodeQL / Dependency Audit を共通ガードレールに追加し、Dependency Audit を npm/Yarn 両対応に汎用化する

ticket-c2c-platform へのセキュリティスキャン導入にあたり、`codeql.yml` / `dependency-audit.yml` を他の 4 種と同様の dual-trigger reusable workflow パターンに揃えた。

- `codeql.yml` に `workflow_call` を追加した。CodeQL の言語解析（`build-mode: none`）は package manager に依存しないため、inputs は不要
- `dependency-audit.yml` は、従来 `working-directory: backstage` 固定・Yarn 4（Corepack）前提の `yarn npm audit` のみに対応していたが、`package-manager`（`npm` / `yarn`、未指定時 `yarn`）と `working-directory`（未指定時 `backstage`）を `workflow_call` の inputs として追加し、npm ベースの消費側（ticket-c2c-platform 等）でも利用できるよう汎用化した。本リポジトリ自身の呼び出し（`backstage/`、Yarn）は既定値により従来と同じ挙動を維持する
- npm workspaces を使わない消費側で複数ディレクトリ（例: root と `frontend/`）を監査する場合は、caller 側で `working-directory` を変えて複数回呼び出す設計とする（reusable workflow 側で配列 input はサポートされないため）
- 両ファイルとも、Issue #106 で確立した規約（caller 側 concurrency group には `-caller` サフィックスを付ける、caller job には `name:` を付けず job id にフォールバックさせる）を新規追加時から適用する

### 消費側への影響

- 両ファイルへの `workflow_call` 追加および `dependency-audit.yml` の入力追加は、本リポジトリ自身の既存トリガー（`push` / `pull_request` / `schedule` / `workflow_dispatch`）や既定挙動を変えないため、非破壊的な変更として `v1.x.y` の patch/minor リリースで扱う
- 既存の `@v1` 消費側（ticket-c2c-platform、他 4 種のみ導入済み）には影響しない。CodeQL / Dependency Audit は新規導入であり、既存の required status checks には追加しない（段階的 required 化の方針は消費側リポジトリごとに判断する）

### 関連

- Issue: [kmryst/idp-golden-path#110](https://github.com/kmryst/idp-golden-path/issues/110)
- idp-golden-path#106（concurrency deadlock / job 名重複の規約確立）

## 追記（2026-07-18）: Dependabot の免除を job 内の明示的な成功経路にする

Commitlint / PR Policy Check の caller job に Dependabot の除外条件を置くと、reusable workflow が呼び出されず、
消費側の branch protection が要求する `<caller job id> / <called job name>` の check が作成されない問題を確認した。

次の選択肢を比較した。

1. caller job 全体をスキップする
2. called workflow の job 全体をスキップする
3. 検査 job の後段に別の Gate job を追加する
4. called workflow の同じ job 内で、通常 PR の検査 step と Dependabot の免除 step を分ける

選択肢 1 は required check が欠落するため不採用とした。選択肢 2 は branch protection を通過できるが、check が `Skipped` と表示され、
意図した免除と予期しないスキップを区別しにくい。選択肢 3 は判定を明示できる一方、job と required status check を増やし、
branch protection の設定変更も必要になる。Commitlint / PR Policy Check はそれぞれ単一の検査 job で完結するため、最小の構成で免除を明示できる選択肢 4 を採用する。

Commitlint は Dependabot が決定する PR タイトルが `header-max-length` に抵触し得るため免除する。PR Policy Check は、人間向けの
Issue link・必須ラベル規約を Dependabot PR に要求しないため免除する。

### 採用する実行契約

- caller workflow と called workflow の job は、Dependabot PR でも常に起動する
- `workflow_call` の caller は `pull_request` イベントから呼び出し、called workflow が `github.event.pull_request` を参照できることを前提とする
- PR 作成者は `github.event.pull_request.user.login` で判定し、workflow を起動した利用者を示す `github.actor` は使わない
- PR 作成者が `dependabot[bot]` の場合は検査 step を実行せず、免除理由を記録する step を実行して job を `Success` で終了する
- 通常 PR では免除 step を実行せず、従来の検査 step をすべて実行する
- job name と required status check は変更しない

### 消費側への影響

- job name、permissions、inputs は変わらないため、非破壊的な `v1.x.y` リリースとして扱い、マージ後に `v1` タグを進める
- service baseline の修正は新規生成リポジトリにだけ反映される。既存利用先の caller workflow は各リポジトリで除外条件を削除する
- 既存利用先への追随は ticket-c2c-platform#331 / terraform-hannibal#518 で扱う

### 関連

- Issue: [kmryst/idp-golden-path#116](https://github.com/kmryst/idp-golden-path/issues/116)
- ticket-c2c-platform#331 / terraform-hannibal#518

## 追記（2026-07-28）: npm audit の一時例外を期限付き reusable workflow input として提供する

npm ベースの消費側で、修正版が存在しない開発依存の High advisory により全 PR の Dependency Audit が継続的に失敗する事象を確認した。
full audit を `devDependencies` ごと無効化すると、CI で実行されるツールチェーンの新たな脆弱性も検出できなくなる。
一方、npm CLI には Yarn 4 の `--ignore` に相当する advisory 単位の除外オプションがない。

### 採用する契約

- npm 消費側向けに、既定値が空配列の optional input `npm-audit-exceptions` を追加する
- 各例外は、完全一致する GHSA ID、UTC の有効期限、GitHub の追跡 Issue URLを必須とし、有効期間は設定時点から最大 90 日に制限する
- 例外設定時も full audit を継続し、`via` 連鎖を根本 advisory まで解決して、許可済み GHSA だけに起因する High を一時許可する
- runtime 依存は、例外適用前に `devDependencies` を除外した別ゲートで監査する
- Critical、未許可の High、期限切れ、不正設定、audit 実行 / JSON 解析異常は fail closed とする
- 修正により例外対象が検出されなくなった場合は pass とし、Job Summary で例外削除を促す。これにより Dependabot の修正 PR を古い例外設定だけでブロックしない
- Yarn 4 は数値 advisory ID を `--ignore` へ渡す既存運用を継続し、GHSA を契約とする npm 用 input の対象外とする

ポリシー評価器は外部 npm package に依存しない Node.js スクリプトとして本リポジトリに置く。
reusable workflow 内の通常の checkout は caller リポジトリを取得するため、評価器だけは `job.workflow_repository` と
`job.workflow_sha` を用いて workflow 定義と同じ repository / commit から sparse checkout する。
これにより、移動タグ `@v1` が解決した workflow と評価ロジックを同じ commit に固定する。
checkout 前に repository が `kmryst/idp-golden-path` と一致し、SHA が完全な commit SHA であることを検証する。
context が欠落・変更された場合は checkout の既定値へフォールバックさせず fail closed にする。

### 消費側とリリースへの影響

- input 未指定時は既存 npm / Yarn gate の fail 条件を維持する。npm full audit は caller の `NODE_ENV` / npm config による暗黙の dev 除外を防ぐため、全依存区分を明示的に include し、監査対象を `package-lock.json` に固定する
- optional input の追加であり、既存消費側へ新しい前提を要求しないため非破壊的な `v1.x.y` リリースとして扱う
- 消費側は共通 workflow のリリース後にだけ新 input を設定する。未リリースの input を現在の `@v1` へ先行指定しない
- 例外の期限延長や削除には caller workflow の PR を必要とし、追跡 Issue と週次 audit で恒久化を防ぐ

### 関連

- Issue: [kmryst/idp-golden-path#130](https://github.com/kmryst/idp-golden-path/issues/130)
- 最初の消費予定: ticket-c2c-platform#348

## 追記（2026-08-05）: yarn パスにも期限付き例外機構を提供する

本リポジトリ自身（Yarn・`backstage/`）の依存グラフに、修正版が major 跨ぎでしか存在しない
transitive 依存の High advisory が発生し、Dependency Audit が PR と無関係に fail し続ける事象を確認した。
常時 fail するゲートは alert fatigue により新規 advisory の検知能力を失わせる。
npm 側の期限付き例外機構（追記 2026-07-28）は yarn パスに適用されないため、同じ契約を yarn にも提供する。

### 採用する契約

- npm 側の契約（完全一致する GHSA ID・UTC の有効期限・追跡 Issue URL 必須、最大 90 日、
  Critical / 未許可 High / 期限切れ / 不正設定 / audit 出力異常は fail closed、
  未検出例外は Job Summary で削除を促す）を踏襲する
- 評価器は npm / yarn で分離する（`scripts/ci/yarn-audit-policy.mjs`）。npm audit の JSON object と
  Yarn 4 の NDJSON（1 advisory = 1 行）は構造が異なり、単一評価器へ統合すると双方の fail closed 条件が曖昧になる。
  例外スキーマの検証（`parseExceptions`）は npm 側実装を共有する
- npm 側と異なり、runtime 依存だけの事前ゲートは持たない。Yarn workspaces のモノレポでは
  フロントエンド実行時依存も production に分類され、「開発依存のみ例外可」という npm 側の境界として機能しないため、
  ガードは severity・期限・追跡 Issue に一本化する
- 例外の宣言場所は実行元で分ける。yarn 消費側は optional input `yarn-audit-exceptions`（既定値は空配列）、
  本リポジトリ自身（`workflow_call` 以外のトリガー）は input を渡せないため
  リポジトリ内ファイル `scripts/ci/yarn-audit-exceptions.json` を読む
- 消費側での評価器の取得は npm 側と同じく `job.workflow_repository` / `job.workflow_sha` からの
  sparse checkout とし、`@v1` が解決した workflow と評価ロジックを同じ commit に固定する
- 評価器へ例外を渡す環境変数は `IDP_YARN_AUDIT_EXCEPTIONS` とし、`YARN_` prefix を避ける
  （Yarn は `YARN_*` を設定値として解釈し、未知の設定名では `yarn npm audit` 自体が Usage Error で失敗する）

### セキュリティ起因 resolutions の台帳と棚卸し

例外機構と同時に導入するセキュリティ起因の `resolutions` も、放置すれば上流更新の足止めという
同型の負債になる。ただし管理機構は例外と意図的に変える。期限付き例外は脆弱性が残ったまま受容するため
解消時期が外から分からず日付（expires）を切るしかないが、resolutions は該当行を外して依存解決し直せば
「まだ必要か」を実測で機械判定できる。そこで resolutions には expires を付けず、次で管理する。

- 追加基準: resolutions なしの fresh resolve でも修正版が選ばれる場合は lockfile 更新だけで解消し、
  resolutions は追加しない。追加するのは依存元が脆弱バージョンを exact pin している等、
  再解決しても修正版が選ばれない場合に限る
- キーは依存元の宣言 range 単位で絞り、右辺は修正版を下限とする range にする（再現性の固定は lockfile の仕事）
- 台帳: `package.json` にコメントを書けないため、理由・対応 GHSA・経路をサイドカー
  `scripts/ci/yarn-resolutions.json` に記録し、`package.json` との同期を毎回 CI で検証する（sync）
- 棚卸し: 台帳の resolutions を全部外した一時プロジェクトで lockfile を再解決して audit を実行し、
  台帳記載の advisory が再出現しない resolution（= 不要）を fail で検出する（stale）。
  期限切れ例外と違い「消すだけ」で対応コストが低く放置する理由がないため、warn ではなく fail とする
- 棚卸しの実行は週次 schedule と手動に限定する。判定材料（上流のリリース）は週次でしか変わらず、
  依存グラフ全体の再解決コストを毎 PR で払う価値がないため
- 台帳と棚卸しは本リポジトリ固有のチェックとして `github.repository` で限定し、
  reusable workflow の消費側では実行しない

### 消費側とリリースへの影響

- 例外未設定時は従来どおり `yarn npm audit --all --recursive --severity high` の素のゲートを実行し、
  既存 yarn 消費側の fail 条件・job name を維持する
- optional input の追加であり、非破壊的な `v1.x.y` リリースとして扱う

### 関連

- Issue: [kmryst/idp-golden-path#133](https://github.com/kmryst/idp-golden-path/issues/133)
- 例外の追跡: [kmryst/idp-golden-path#134](https://github.com/kmryst/idp-golden-path/issues/134)

## 追記（2026-08-11）: コンテナイメージと IaC 設定の Trivy スキャンを共通ガードレールに追加する

`npm audit` / Dependabot alerts が原理的に見られない 2 つの領域を埋めるため、
`trivy-image.yml`（コンテナイメージの中身）と `trivy-config.yml`（IaC / Dockerfile の設定不備）を追加した。

3 リポジトリで Trivy の運用が分散していた（terraform-hannibal は週次 Security Scan の container scan と
PR の Trivy Config Scan、ticket-c2c-platform は `trivy fs`）ため、共通部分を本リポジトリの
reusable workflow に寄せる。npm 依存の CVE は既に `npm audit`（blocking、全依存区分 include）と
Dependabot alerts が見ているため、`trivy fs` は共通ガードレールに含めない。

### 2 本に分ける理由

単一の `trivy.yml` にせず 2 ファイルに分ける。

- 実行コストが桁違いで、適切なトリガーが変わる。image はビルドを含み 1〜2 分、config は数秒
  （本リポジトリの clean tree で 0.9 秒、ticket-c2c-platform で 4.5 秒を実測）
- 必要な permissions が違う。image は SARIF 送信のため `security-events: write` を要求するが、
  config は当面 `contents: read` のみで足りる。reusable workflow の job が要求する permission は
  caller の付与範囲を超えられないため、両者を 1 ファイルにすると config だけ使いたい消費側にも
  `security-events: write` の付与を強いることになる
- 呼び出し回数が違う。image は backend / frontend で 2 回、config はリポジトリごとに 1 回

### `trivy-image.yml` は dual-trigger にしない（本 ADR の作法からの逸脱）

他の共通ガードレールは `pull_request` + `workflow_call` の dual-trigger で本リポジトリの CI を兼ねるが、
`trivy-image.yml` は **`workflow_call` 専用**とする。本リポジトリの Dockerfile
（`backstage/packages/backend/Dockerfile`）はビルド前にホスト側で `yarn install --immutable` /
`yarn tsc` / `yarn build:backend` を実行しておく必要があり（Dockerfile 冒頭に明記）、
「checkout してそのまま `docker build` する」という素の手順に乗らないためである。
dual-trigger にするには本リポジトリ専用のビルド前処理を reusable workflow 側へ持ち込むか、
消費側に不要な inputs を足すことになり、共通化の趣旨に反する。

逸脱の代償は「本リポジトリで 1 度も実行されないまま消費側に配布される」ことである。
これを埋めるため、`trivy-image-selftest.yml`（薄い caller）と最小フィクスチャ
`scripts/ci/fixtures/trivy-image/{primary,secondary}/Dockerfile` を恒久資産として置き、
`uses: ./.github/workflows/trivy-image.yml` のローカル参照で自リポジトリの CI から実行する。
フィクスチャは `FROM` 1 行のみで、ベースイメージ由来の finding が必ず出るため
「0 件だから緑」と「検出できていないから緑」を区別できる。
selftest は `trivy-image.yml` 本体・caller・フィクスチャを触った PR でだけ走らせる（paths filter）。
required status check にはしないため、paths filter による check 欠落の問題は起きない。

`trivy-config.yml` は本リポジトリ自身も `terraform/` を持ち、素の checkout だけで検査が成立するため、
規約どおり dual-trigger とする。

### exit-code の既定を `'0'`（非 blocking）にする

両 workflow とも `exit-code` の既定は `'0'` とし、finding があっても job を fail させない。

- image: ticket-c2c-platform の実測（Trivy 0.70.0、`CRITICAL,HIGH`）で 29 件が検出され、
  そのうち **22 件が修正不能**（affected 16 / fix_deferred 5 / will_not_fix 1）だった。
  `exit-code: 1` にすると base image を最新にしても恒久的に fail する。
  常時 fail するゲートは alert fatigue により検知能力を失う（追記 2026-08-05 で実測済みの失敗パターン）
- config: ticket-c2c-platform で 41 件（CRITICAL 10 / HIGH 31）、本リポジトリで 10 件（CRITICAL 3 / HIGH 7）が
  いずれも未棚卸しであり、accepted risk 候補を含む

blocking 化（`exit-code: '1'` / required status check 昇格）は、finding の分類と
accepted risk / ignore 理由の記録を終えてから**別 Issue で判断する**。
これは terraform-hannibal ADR-0012 が `Trivy Config Scan` に対して採った段階的アプローチと同じである。
`exit-code` は input として提供するので、棚卸しの済んだ消費側は caller の 1 行変更で blocking 化できる。

### SARIF の扱いを image と config で変える

- image は SARIF を Security > Code scanning alerts へ送る（`upload-sarif`、既定 true）
- config は**初期は SARIF を上げず** Step Summary + artifact に留める（terraform-hannibal の `trivy-config` と同型）。
  未棚卸しの数十件を Security タブへ流すと既存の CodeQL alert が埋もれるため

同一リポジトリから複数の SARIF を上げる場合、`github/codeql-action/upload-sarif` の `category` を
分けないと後の upload が前を上書きし、先に上げた側の alert が消える。
そのため `trivy-image.yml` は `category: trivy-image-<image-name>` を強制し、
`image-name` を必須 input にしている。既存の Trivy fs は単一アップロードだったためこの問題が顕在化していなかった。
category を意図的に衝突させたときに片方の alert が実際に消えることは、selftest の
`same-category` オプションを使ったネガティブテストで実測している
（検証記録: `docs/operations/verification/2026-08-11-trivy-reusable-workflows/`）。

また `trivy-action` は SARIF 出力時、`limit-severities-for-sarif` を指定しないと
`severity` 指定を無視して全 severity を Security タブへ送る（v0.36.0 の `entrypoint.sh` が
`TRIVY_SEVERITY` を unset する）。Step Summary の集計と Security タブの件数を一致させるため、
`limit-severities-for-sarif: true` を指定する。

### `trivy-config.yml` に `scanners` input を持たせない

terraform-hannibal の既存 job は `scanners: misconfig` を渡しているが、これは実測上 no-op である。
`trivy-action` は入力を CLI フラグではなく `TRIVY_*` 環境変数として渡し、`trivy config` サブコマンドは
`--scanners` フラグを持たないため `TRIVY_SCANNERS` を束縛しない（不正な値を渡してもエラーにならないことを
Trivy 0.70.0 で実測）。効かない input を契約に残すと「切り替えられる」という誤解を生むため提供しない。

### 消費側とリリースへの影響

- 新規 workflow の追加であり、既存 workflow の job name・inputs・check run 名は変えないため、
  非破壊的な `v1.x.y` リリースとして扱う
- `trivy-image.yml` の caller は job に `security-events: write` を必ず付与すること。
  `upload-sarif: false` で呼ぶ場合も、callee の job 定義自体が要求するため付与が必要である
  （付与しないと job が 1 つも起動せず run 全体が失敗する）
- `trivy-image.yml` は workflow レベルの concurrency を持たない。同一 caller から複数イメージを
  並行 scan するのが通常の使い方であり、callee 側に group を置くと相互キャンセルするため。
  直列化が必要な場合は caller 側で `-caller` サフィックス付きの group を持つ
- `trivy-config.yml` は dual-trigger のため、本リポジトリでは `Trivy Config Scan` という
  check run が全 PR に増える。required status checks には追加しない
- ticket-c2c-platform / terraform-hannibal 側の caller 実装と既存 Trivy job の整理は、
  本 PR のマージと `v1` タグ更新の後に各リポジトリの Issue / PR で行う

### 関連

- Issue: [kmryst/idp-golden-path#181](https://github.com/kmryst/idp-golden-path/issues/181)
- terraform-hannibal ADR-0012（IaC security scan を Trivy Config に集約し、blocking gate 化は finding 棚卸し後に別 Issue とする前例）
- 検証記録: [2026-08-11 Trivy reusable workflows](../operations/verification/2026-08-11-trivy-reusable-workflows/README.md)

## 追記（2026-08-12）: `workflow_call` の boolean input には `default:` を必ず宣言する

### 何が起きたか

追記 2026-08-11 で `trivy-image.yml` の `upload-sarif` を「既定 true」と決め、
`docs/operations/security-scanning.md` の inputs 表にもそう書いたが、
**workflow 定義に `default: true` を宣言していなかった。**

`workflow_call` の `type: boolean` input は、caller が値を渡さず定義側に `default:` も無い場合、
`inputs.<name>` が `false` に評価される。string input で慣用の
`inputs.severity || 'CRITICAL,HIGH'` 方式（未指定なら空文字なのでフォールバックが効く）とは異なり、
boolean は「未指定」と「明示的な false」を式の側で区別できない。

結果、`if: ${{ inputs['upload-sarif'] != false }}` が偽になり、
`Scan image (sarif)` と `Upload SARIF to code scanning` が skip された。
**skip されても job は success** なので、ticket-c2c-platform の
[run 31567906354](https://github.com/kmryst/ticket-c2c-platform/actions/runs/31567906354) では
backend / frontend の両 job が緑のまま SARIF を 1 件も上げていなかった。

これは「壊れたことが分かる失敗」ではなく「守っているつもりで守っていない」silent failure であり、
セキュリティガードレールとしては最も避けたい失敗モードである。

### なぜ selftest で検知できなかったか

`trivy-image-selftest.yml` の primary / secondary は、いずれも `upload-sarif` を
`${{ github.event_name == 'workflow_dispatch' && inputs['upload-sarif'] == true }}` という式で
**必ず明示**して呼んでいた。この式は常に `true` / `false` のどちらかに評価されるため、
「caller が input を省略する」という、消費側で最も普通の呼び方が 1 度も実行されていなかった。

reusable workflow の selftest は「動く経路」だけでなく
**「既定値に頼る経路」を明示的に持たなければ契約を守れない。**

### 決定

- `workflow_call` の `type: boolean` input には `default:` を必ず宣言する。
  既定値の正本は input 宣言側に置き、`if:` の式は
  「明示的に false を渡されたときだけ止める」役割に徹する（`!= false` を維持する）
- 宣言漏れを機械的に検知する。二段構えにする。
  - `scripts/ci/workflow-input-contract.mjs`: リポジトリ内の全 workflow を静的検査し、
    `default:` の無い boolean input を fail させる。selftest の `contract` job から全 PR で実行する
    （docker build を伴わないため安価）
  - selftest の `default-upload-sarif` job: `upload-sarif` を**渡さずに**呼び、
    既定値が実際に効いて SARIF が上がることを実行時に実証する。
    フィクスチャ由来 alert を常時流さないため `workflow_dispatch` かつ `upload-sarif: true` に限定する

### 検討した代替案

- **`if:` を `== true` に変える**: `default: true` があれば挙動は同じで、直しにはならない。
  むしろ既定値が式と宣言の 2 箇所に散るため採らない
- **消費側で常に `upload-sarif: true` を明示させる**: 宣言済みの既定値を毎回書かせる運用であり、
  「既定 true」という契約そのものを放棄することになる。ticket-c2c-platform で一時的に採った回避策で、
  本追記の対応後に外した
- **YAML パーサ（js-yaml 等）を devDependency に追加する**: 検査対象は
  `on: > workflow_call: > inputs:` ブロックだけであり、依存と Dependabot の面積を増やす価値がない。
  インデントベースの最小走査 + `node --test` の単体テストで足りる

### 影響

- 全 16 workflow を精査し、`default:` の無い boolean input は `upload-sarif` の 1 件だけだった
  （`trivy-config.yml` は boolean input を持たない。selftest の 2 つは `workflow_dispatch` input で、
  未指定時 false でよいため対象外）
- `trivy-image.yml` の job name / inputs / check run 名は変えていないため、消費側に非破壊。
  `v1.7.1` として発行し `v1` を付け替える
- ドキュメント（`security-scanning.md` の inputs 表、本 ADR 追記 2026-08-11）の記述は元から
  「既定 true」で正しく、**実装がドキュメントに追いついた**形になる。表の修正は不要

### 関連

- Issue: [kmryst/idp-golden-path#186](https://github.com/kmryst/idp-golden-path/issues/186)
- 消費側での実地検証: [kmryst/ticket-c2c-platform#474](https://github.com/kmryst/ticket-c2c-platform/pull/474)

## 関連

- Issue: [kmryst/idp-golden-path#39](https://github.com/kmryst/idp-golden-path/issues/39)
- [CI 品質ゲート トラブルシューティング](../operations/ci-quality-gates-troubleshooting.md)（reusable workflow の concurrency 起因でマージがブロックされた事象と `queue: max` 対応）
- [ADR 0002. 既存 2 リポジトリの軽運用 / 厳密運用 GitHub Flow モデルを踏襲する](./0002-adopt-lightweight-and-strict-github-flow.md)
- [ADR 0006. Scaffolder ゴールデンパスは「リポジトリ・ガバナンスベースライン」テンプレートとして提供する](./0006-scaffolder-service-baseline-template.md)
- [GitHub Docs: Reusing workflows](https://docs.github.com/en/actions/using-workflows/reusing-workflows)
- [GitHub Docs: Security hardening for GitHub Actions](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions)
