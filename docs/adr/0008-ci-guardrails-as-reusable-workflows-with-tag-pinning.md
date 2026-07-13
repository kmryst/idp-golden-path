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

## 関連

- Issue: [kmryst/idp-golden-path#39](https://github.com/kmryst/idp-golden-path/issues/39)
- [CI 品質ゲート トラブルシューティング](../operations/ci-quality-gates-troubleshooting.md)（reusable workflow の concurrency 起因でマージがブロックされた事象と `queue: max` 対応）
- [ADR 0002. 既存 2 リポジトリの軽運用 / 厳密運用 GitHub Flow モデルを踏襲する](./0002-adopt-lightweight-and-strict-github-flow.md)
- [ADR 0006. Scaffolder ゴールデンパスは「リポジトリ・ガバナンスベースライン」テンプレートとして提供する](./0006-scaffolder-service-baseline-template.md)
- [GitHub Docs: Reusing workflows](https://docs.github.com/en/actions/using-workflows/reusing-workflows)
- [GitHub Docs: Security hardening for GitHub Actions](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions)
