# 0006. Scaffolder ゴールデンパスは「リポジトリ・ガバナンスベースライン」テンプレートとして提供する

## ステータス

Accepted

## 日付

2026-07-07

## 決定内容

最初のゴールデンパステンプレートを次の構成で実装する。

- 粒度: 言語・フレームワーク別のサービステンプレートではなく、**リポジトリ・ガバナンスベースライン**（`service-baseline`）を単一テンプレートとして提供する。アプリケーションコードのひな形は含めない
- 配置: `backstage/templates/service-baseline/`（`template.yaml` + `skeleton/`）。`backstage/examples/` は `@backstage/create-app` の生成物として温存し、混在させない
- GitHub 連携: `publish:github` アクション + Personal Access Token（PAT）。トークンは `app-config.yaml` の `integrations.github` が参照する `GITHUB_TOKEN` 環境変数で注入し、ファイルには書かない
- 焼き込み範囲: 本リポジトリで確立した運用資産一式を skeleton に含める
  - `CLAUDE.md` / `CONTRIBUTING.md`（軽運用 / 厳密運用 GitHub Flow、必須ラベル 4 種、Conventional Commits）
  - `.github/labels.yml` と CI workflows 5 本（PR Policy Check / Commitlint / Markdown Lint / Gitleaks Secret Scan / Sync Labels）、composite action、PR / Issue テンプレート
  - `scripts/github/` helper（Issue / PR 作成、ラベル同期、ブランチ cleanup）
  - commitlint / markdownlint 設定、`package.json` + `package-lock.json`
  - ADR 運用（`docs/adr/README.md` + 生成経緯を記録する初期 ADR 0001）
  - TechDocs 対応（`mkdocs.yml` + `docs/`）と `catalog-info.yaml`（生成直後に Software Catalog へ登録可能）
- branch protection: テンプレートでは**自動適用しない**。生成物の `docs/operations/branch-protection.md` に適用コマンド（`gh api`）を記載し、初回 CI 実行後の手動適用とする
- テンプレート展開: `fetch:template` を使い、GitHub Actions 式（`${{ github.* }}` / `${{ secrets.* }}`）を含む `.github/workflows/**` / `.github/actions/**` と、bash の `${#array[@]}` が nunjucks のコメント開始 `{#` と衝突する `scripts/github/**` は `copyWithoutTemplating` で無変換コピーする

## 背景

README / ADR-0001 が掲げる本プロジェクトの核心価値は「サービス新規立ち上げ時のゴールデンパス（テンプレート・CI/CD・インフラ・ガードレールの一括提供）のセルフサービス化」である。しかし現状は Software Catalog（ADR-0004）と TechDocs（ADR-0005）のみが実装済みで、Scaffolder テンプレートが存在しない。

一方、[terraform-hannibal](https://github.com/kmryst/terraform-hannibal) / [ticket-c2c-platform](https://github.com/kmryst/ticket-c2c-platform) および本リポジトリ自身の立ち上げで毎回手作業になっていたのは、アプリケーションコードの雛形ではなく、**リポジトリ運用のガードレール**（ラベル定義、PR ポリシー CI、commitlint、secret scan、ADR 運用、Issue / PR テンプレート、helper scripts）の再整備だった。ゴールデンパスとして最初に自動化すべき価値はここにある。

## 検討した選択肢

### テンプレートの粒度

#### リポジトリ・ガバナンスベースライン単体（採択）

- 長所: 既存 3 リポジトリで実証済みの運用資産をそのまま製品化でき、言語を問わず適用できる
- 長所: skeleton の正本が本リポジトリ自身のファイルなので、乖離の検知・追随が容易
- 短所: 生成直後に動くアプリケーションコードは含まれない（`git clone` 後にコードを足す前提）

#### 言語別サービステンプレート（Node.js 等、見送り）

- 長所: 生成直後にビルド・デプロイまで通る「フルスタックの初速」を提供できる
- 短所: ランタイム・フレームワーク・デプロイ先（AWS 構成は未確定、ADR-0003）の選定が先に必要で、確立済みでない判断をテンプレートに焼き込むことになる
- 短所: 言語ごとに skeleton が分裂し、ガバナンス部分の重複管理が発生する

言語別テンプレートは、ガバナンスベースラインを `fetch:template` で合成する後続テンプレートとして追加できるため、粒度を小さく始めても拡張パスは失われない。

### GitHub 連携方式

#### PAT（`GITHUB_TOKEN` 環境変数）（採択）

- 長所: `app-config.yaml` の `integrations.github` が既定で参照する方式で、追加実装が不要
- 長所: ローカル開発（guest 認証 + インメモリ SQLite、ADR-0003）と整合し、`gh auth token` で発行済みトークンを転用できる
- 短所: トークンが個人アカウントに紐づき、実行者の権限で publish される（監査上はプラットフォーム名義にならない）

#### GitHub App（見送り）

- 長所: 名義がアプリになり、fine-grained な権限と組織単位のインストール管理ができる。チーム運用では推奨構成
- 短所: App 登録・秘密鍵管理・Org が前提となり、個人ポートフォリオのローカル開発フェーズには過剰。デプロイ・マルチユーザー化の段階で再判断する

### 運用資産の焼き込み範囲

#### 運用資産一式を skeleton に含める（採択）

- 長所: 生成直後から Issue / PR 駆動 + required checks 相当の CI が機能し、「ガードレールの一括提供」という価値をそのまま示せる
- 短所: skeleton が本体の運用ファイルのコピーになるため、本体更新時に乖離し得る。当面は PR レビューで追随し、乖離検知の自動化（diff チェック CI）は必要になった時点で別 Issue とする

#### 最小構成（README + catalog-info.yaml のみ、見送り）

- 長所: skeleton の保守がほぼ不要
- 短所: 生成物にガードレールがなく、既存リポジトリで起きた「運用の再発明」を解消できない。ゴールデンパスの核心価値が示せない

### branch protection の扱い

#### 生成物に適用手順を文書化し手動適用（採択）

- 長所: required status checks は各 workflow の初回実行前に設定すると PR を恒久ブロックし得るため、初回 CI 実行後の適用が安全
- 長所: 私有リポジトリでは GitHub のプラン制約で branch protection が使えない場合があり、可視性に依存する判断を人間側に残せる
- 短所: 生成直後は direct push が可能な期間が生じる（本体の `docs/operations/branch-protection.md` と同じく、適用内容を正本ドキュメントとして生成物に含めることで補う）

#### `publish:github` の `protectDefaultBranch` で自動適用（見送り）

- 長所: 生成と同時に保護がかかる
- 短所: required checks の文脈名まではテンプレート実行時点で保証できず、失敗時に scaffolder タスク全体が失敗する。プラン・可視性依存のエラーも利用者側で切り分けにくい

## 採択理由

- 既存リポジトリで実証済みの運用（ADR-0002 で踏襲を決めた軽運用 / 厳密運用 GitHub Flow と、その実装である CI・ラベル・helper）を、未確定の技術選定を持ち込まずにセルフサービス化できる最小で最大価値の単位が「ガバナンスベースライン」である
- PAT 方式はローカル開発基準（ADR-0003）と整合し、秘匿情報を環境変数注入に限定することで `.env` コミット禁止等の既存ルールとも矛盾しない

## 影響

- `backstage/templates/` ディレクトリが新設され、以後のテンプレートはここに追加する
- テンプレートの Catalog 登録は ADR-0004 と同じ file location 方式で `app-config.yaml` に追加する（別 Issue）
- skeleton は本体運用ファイルのコピーを含むため、`CLAUDE.md` / `CONTRIBUTING.md` / `.github/**` / `scripts/github/**` を変更する PR では skeleton への追随要否を確認する
- GitHub App 移行は [ADR-0007](./0007-scaffolder-github-app-authentication.md) で実機検証の上、個人アカウント運用を続ける限り移行しないと判断した
- 言語別サービステンプレート・skeleton 乖離検知 CI は、それぞれ必要になった段階で別 ADR / Issue として扱う

## 関連

- [ADR 0001](./0001-adopt-backstage-for-idp-portfolio.md) — Backstage 採用（ゴールデンパスのセルフサービス化）
- [ADR 0002](./0002-adopt-lightweight-and-strict-github-flow.md) — 軽運用 / 厳密運用 GitHub Flow（skeleton が配布する運用モデル）
- [ADR 0003](./0003-backstage-app-layout-and-local-dev-baseline.md) — ローカル開発基準（guest 認証 + インメモリ SQLite）
- [ADR 0004](./0004-catalog-registration-via-local-stub-locations.md) — file location によるカタログ登録
- Issue [#24](https://github.com/kmryst/idp-golden-path/issues/24)
