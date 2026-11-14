# inventory: idp-golden-path のコンポーネント関係図

## 冒頭

- 作成日: 2026-11-03
- 入力: 調査担当 2 人（Backstage / GitHub CI）の報告（リポジトリの外に置き、公開しない）と、突き合わせ担当によるコードの確認
- 根拠のパス: idp-golden-path のファイルはリポジトリルートからの相対パス、他のリポジトリのファイルは `kmryst/<リポジトリ名>:<パス>`。`:数字` は行番号
- 対象（現行と判断した根拠）:
  - idp-golden-path の `main`（66937c4、`origin/main` と一致、作業ツリーは clean）。fetch はしていない
  - 呼び出し側: terraform-hannibal `main`（c3c9501）、ticket-c2c-platform `main`（16bc466）、felis-ai-chatbot `origin/main`（ローカルの参照。`git grep origin/main` で読んだ）
  - reusable workflow の配布版はタグ `v1`。`v1` と `v1.7.2` は同じ commit（dca5d23）を指す（ローカルのタグ。`git rev-parse v1 v1.7.2`）。`v1` の tree に 12 本の reusable workflow がすべて含まれる（`git ls-tree v1 .github/workflows/`）
  - Backstage の実行環境は 2 つある。ローカル（`yarn start`、guest 認証、SQLite）が常用で、本番（AWS）は検証時だけ deploy して destroy する（README.md:15-16、ADR 0009、`.github/workflows/destroy.yml`）。図は環境に依存しない「コンポーネントの関係」を描き、AWS の配置は描かない（ユーザー決定）
- 図の種類: C4 model の System Context / Container に近いコンポーネントの関係図（1 枚）。クラウドの配置図（C4 の Deployment diagram）ではない
- 矢印の読み替え: 矢印は通信の向きではない。向きは関係ごとに決める（2026-11-14 ユーザー決定）。CI ガードレールは Reusable workflows → 各リポジトリ（共有する側から共有される側）、`catalog-info.yaml` は各リポジトリ → Software Catalog（取り込まれる側から取り込む側）。応答は描かない。線のラベルは C4 の形（1 行目に目的、2 行目に `[手段]`。例: `uses: @v1`、`publish:github`）
- 枠の読み替え: グループ枠は C4 の system boundary（または container の境界）。このシステムが提供するもの（idp-golden-path = software system、Backstage = container）に限り、置き場所（GitHub など）や機能の分類で枠を作らない（2026-11-03 ユーザー決定）
- 「作図」列の凡例:
  - 描く: 図に載せる
  - 描かない（理由）: 図に載せない。理由を併記
  - 表へ: 図には載せず、README の表（reusable workflow 一覧）に回す
  - 不明: コードで確認できない。描かない

## 要素一覧

### 人（C4 の Person）

| 名称 | 種類 | 役割 | 作図 | system boundary | 根拠 |
| --- | --- | --- | --- | --- | --- |
| Developer | Person | Software Template を選んで実行し、リポジトリを作る。Software Catalog・TechDocs を閲覧する | 描く | 枠の外 | Backstage 公式「For end users (developers)」（<https://backstage.io/docs/overview/what-is-backstage>）、docs/operations/scaffolder-github-integration.md:52-56 |
| Platform engineer | Person | Backstage・Software Template・reusable workflow を保守し、タグを付けて配布する | 描く | 枠の外 | catalog/org.yaml:7（`Platform Engineer (portfolio owner)`）、Backstage 公式「For platform engineers」（同上 URL）、ADR 0008:16-39 |

### idp-golden-path が提供するもの

| 名称（公式名） | 種類 | 役割 | 作図 | system boundary | 根拠 |
| --- | --- | --- | --- | --- | --- |
| Backstage | Container（frontend `packages/app` + backend `packages/backend`） | Developer portal。下の 3 機能を載せる | 描く（境界として） | idp-golden-path | backstage/packages/backend/src/index.ts:9-71、backstage/packages/app/src/App.tsx:1-8 |
| Software Catalog | Component（plugin `catalog` / `catalog-backend`） | エンティティ（Component・System・User・Group・Template）を取り込んで表示する | 描く | Backstage | index.ts:35-41、backstage/app-config.yaml:105-134 |
| Software Templates（Scaffolder） | Component（plugin `scaffolder-backend`、`scaffolder-backend-module-github`） | テンプレートを実行する。`publish:github` は github module が提供する | 描く | Backstage | index.ts:16-21 |
| TechDocs | Component（plugin `techdocs` / `techdocs-backend`） | `mkdocs.yml` と `docs/` をビルドして表示する | 描く | Backstage | index.ts:23-24、app-config.yaml:73-80 |
| service-baseline | Software Template（`template.yaml` + `skeleton/`） | リポジトリのガバナンスベースライン（caller workflow 7 本、ラベル定義、Issue / PR テンプレート、helper、`catalog-info.yaml`、`mkdocs.yml`）を生成する。アプリケーションのコードは含めない | 描く（skeleton を含めて 1 つ） | idp-golden-path | backstage/templates/service-baseline/template.yaml:1-131、ADR 0006:13-25 |
| Reusable workflows | GitHub Actions の reusable workflow（`workflow_call` を持つ 12 本） | CI ガードレールの正本。呼び出し側の caller workflow から `uses:` で呼ばれる | 描く（箱 1 つ。中身は README の表） | idp-golden-path | .github/workflows/*.yml の `on: workflow_call`、ADR 0008:16-39 |
| Search（`search-backend`、`-module-pg`） | plugin | Catalog と TechDocs の検索 | 描かない（Backstage 内部の補助機能。関係図の論点でない） | Backstage | index.ts:50-59 |
| Auth（guest / GitHub provider）、Sign-in page | plugin・設定 | ローカルは guest、本番は GitHub OAuth | 描かない（認証の詳細。本番は常時動いていない） | Backstage | index.ts:26-32、backstage/app-config.production.yaml:45-57 |
| Permission framework（allow-all policy） | plugin | 全許可 | 描かない（実質的な制御が無い） | Backstage | index.ts:43-48、app-config.yaml:163-165 |
| Kubernetes | plugin | 組み込みのみ。`kubernetes:` 設定が無い | 描かない（使われていない） | Backstage | index.ts:61-62 |
| Notifications / Signals、MCP Actions、Proxy | plugin | 通知、actions の MCP 公開、proxy（endpoint 未定義） | 描かない（関係図の論点でない／proxy は未使用） | Backstage | index.ts:13-14,64-69、app-config.yaml:43-47,61-67 |
| example-nodejs-template と examples のエンティティ | create-app のサンプル | ローカルだけで登録 | 描かない（ローカル専用のサンプル） | — | app-config.yaml:136-150、app-config.production.yaml:71-96 |
| Database（SQLite / Aurora Serverless v2）、Amazon S3（TechDocs）、ECS Fargate など | 実行環境 | Backstage の配置先 | 描かない（AWS の配置の詳細。ユーザー決定） | — | app-config.yaml:39-41、app-config.production.yaml:25-66、ADR 0009 |
| Deploy / Destroy workflow、backstage-ci、trivy-image-selftest、workflow-input-contract | idp-golden-path 自身の workflow（`workflow_call` を持たない） | 自分の CI と本番の deploy / destroy | 描かない（呼び出し側に配るものではない。deploy は AWS の配置） | — | .github/workflows/{deploy,destroy,backstage-ci,trivy-image-selftest,workflow-input-contract}.yml の `on:` |

### GitHub（サービスリポジトリ）

| 名称 | 種類 | 役割 | 作図 | system boundary | 根拠 |
| --- | --- | --- | --- | --- | --- |
| New repository（service-baseline が作るリポジトリ） | Software System（GitHub repository） | テンプレートの生成物。caller workflow 7 本と `catalog-info.yaml` を持つ。**実在する例は無い**（実装上の生成物） | 描く（実線。ユーザー決定） | 枠の外（外部の software system） | template.yaml:81-116、skeleton の `.github/workflows/*.yml`（7 本、すべて `@v1`） |
| terraform-hannibal | Software System（GitHub repository） | caller workflow で reusable workflow を呼ぶ。Software Catalog に Component として登録済み | 描く | 枠の外（外部の software system） | kmryst/terraform-hannibal:.github/workflows/*.yml、kmryst/terraform-hannibal:catalog-info.yaml、app-config.yaml:119-120 |
| ticket-c2c-platform | Software System（GitHub repository） | 同上。Software Catalog に登録済み | 描く | 枠の外（外部の software system） | kmryst/ticket-c2c-platform:.github/workflows/*.yml、kmryst/ticket-c2c-platform:catalog-info.yaml、app-config.yaml:121-122 |
| felis-ai-chatbot | Software System（GitHub repository） | skeleton の手動コピーで作られ、caller workflow 7 本（`@v1`）で reusable workflow を呼ぶ。Software Catalog には**未登録** | 描く | 枠の外（外部の software system） | felis の `origin/main` の `.github/workflows/*.yml`、kmryst/felis-ai-chatbot:docs/adr/0001-bootstrap-by-manual-skeleton-copy.md:13-21、`origin/main` に `catalog-info.yaml` が無い（`git ls-tree`） |
| GitHub Code scanning、Step Summary、workflow artifact | GitHub の機能 | reusable workflow の結果の送り先 | 表へ | — | codeql.yml:61、trivy-image.yml:181-184、dependency-audit.yml:148、trivy-config.yml:184 |
| Dependabot（`package-ecosystem: github-actions`） | GitHub の機能 | caller workflow の `uses:` のタグを更新する PR を作る | 描かない（README 本文で説明。図の主題はテンプレートと呼び出し関係） | — | ADR 0008:39、skeleton/.github/dependabot.yml:3 |

## 関係

番号は「Software Template でリポジトリを作り、CI を動かすまで」。

| # | 矢印の始点 | 矢印の終点 | 関係の種類 | 手段（線のラベルの 2 行目） | 作図 | 番号 | 根拠 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Developer | Software Templates | 使う（テンプレートを選んで実行） | `[Web browser]`（`/create`） | 描く | ① | scaffolder-github-integration.md:52-56、README.md:50-52 |
| 2 | Software Templates | service-baseline | 読み込む（skeleton を展開） | `[fetch:template]` | 描く | ② | template.yaml:81-94（step `fetch-skeleton`） |
| 3 | Software Templates | New repository | 生成する（作成して初回 push） | `[publish:github]` | 描く | ③ | template.yaml:96-108（step `publish`）。認証は `integrations.github.token`（app-config.yaml:51-55、ADR 0007:13） |
| 4 | Software Templates | Software Catalog | 登録する | `[catalog:register]` | 描く | ④ | template.yaml:110-116（step `register`。`steps['publish'].output.repoContentsUrl` を使うので ③ の後） |
| 5 | Reusable workflows | New repository（caller workflow 7 本） | 共有する（CI ガードレールの共有） | `[uses: @v1]` | 描く | ⑤ | skeleton の `.github/workflows/*.yml`（7 本すべて `@v1`）。template の output「最初の PR で CI の実行実績を作る」（template.yaml:126-131） |
| 6 | Reusable workflows | terraform-hannibal（caller workflow） | 共有する（CI ガードレールの共有） | `[uses: @v1]` | 描く | — | kmryst/terraform-hannibal:.github/workflows/*.yml（9 種・10 回、すべて `@v1`） |
| 7 | Reusable workflows | ticket-c2c-platform（caller workflow） | 共有する（CI ガードレールの共有） | `[uses: @v1, @v1.7.2]` | 描く | — | kmryst/ticket-c2c-platform:.github/workflows/*.yml（12 種・14 回。`@v1` 5 種、`@v1.7.2` 7 種） |
| 8 | Reusable workflows | felis-ai-chatbot（caller workflow） | 共有する（CI ガードレールの共有） | `[uses: @v1]` | 描く | — | felis `origin/main` の `.github/workflows/*.yml`（7 種、すべて `@v1`） |
| 9 | terraform-hannibal | Software Catalog | 取り込まれる（catalog-info.yaml の取り込み） | `[url location]` | 描く | — | app-config.yaml:119-120、app-config.production.yaml:83-84、ADR 0011:13-20 |
| 10 | ticket-c2c-platform | Software Catalog | 取り込まれる（catalog-info.yaml の取り込み） | `[url location]` | 描く | — | app-config.yaml:121-122、app-config.production.yaml:85-86 |
| 11 | Developer | Software Catalog | 使う（サービスと docs の閲覧） | `[Web browser]` | 描く | — | app-config.yaml:8-12（トップページが catalog）。TechDocs は entity のページから開く |
| 12 | Platform engineer | idp-golden-path（boundary） | 保守する | `[Git]` | 描く | — | catalog/org.yaml:7 |
| 13 | Platform engineer | Reusable workflows | タグでの配布 | `[Git tag v1.x.y, v1]` | 描く | — | ADR 0008:16-39（immutable タグ `v1.x.y` と移動 major タグ `v1`。タグで配布するのは reusable workflow だけ） |
| 14 | Software Catalog | TechDocs | docs の表示（entity のページから docs を開く） | `[backstage.io/techdocs-ref]` | 描く | — | app-config.yaml:73-80、skeleton/catalog-info.yaml:9（annotation `backstage.io/techdocs-ref`） |
| 15 | New repository | Software Catalog | 取り込まれる（catalog-info.yaml の取り込み） | `[url location]` | 描かない（④ が登録した location の読み込みで、④ と重なる） | — | template.yaml:110-116 |
| 16 | Software Catalog | service-baseline・`catalog/org.yaml`・`catalog/portfolio.yaml`・自身の `catalog-info.yaml` | 読み込む | `[file location]` | 描かない（idp-golden-path 内部の設定。② で template と Scaffolder の関係は示せる） | — | app-config.yaml:109-134 |
| 17 | TechDocs | New repository / idp-golden-path の docs | 読み込む・ビルドする | `[techdocs-ref: dir:.]` | 描かない（生成リポジトリのビルドは実績の記録が無い。本番は idp-golden-path 自身の docs だけを CI が S3 へ publish する。hannibal・ticket は `techdocs-ref` を持たない） | — | app-config.yaml:73-80、skeleton/catalog-info.yaml:9、deploy.yml:101-111 |
| 18 | felis-ai-chatbot | service-baseline（skeleton） | 手動でコピーして作られた | 手作業 | 描かない（システムが行う関係ではない。矢印にすると自動の生成に読める。README の表の「生成元」で示す） | — | felis ADR 0001:13-21 |
| 19 | terraform-hannibal / ticket-c2c-platform | service-baseline | — | — | 描かない（テンプレートで作られていない。後から caller workflow を取り込んだ） | — | hannibal の初回 commit 2025-04-10、hannibal #500〜#513・ticket #299〜#308（GitHub CI 担当の報告） |
| 20 | Reusable workflows | GitHub Code scanning / Step Summary / artifact | 結果を送る | SARIF、`$GITHUB_STEP_SUMMARY`、upload-artifact | 表へ | — | codeql.yml:61、trivy-image.yml:181-184、dependency-audit.yml:148、trivy-config.yml:184 |
| 21 | Dependency Audit / Dependency Unblock Check | idp-golden-path の `scripts/ci/*.mjs` | 取得する | `job.workflow_sha` で sparse checkout | 描かない（reusable workflow の内部の実装） | — | dependency-audit.yml:319-325、ADR 0008:182-186 |
| 22 | Dependabot | caller workflow の `uses:` | 更新 PR を作る | `dependabot.yml` | 描かない（要素一覧の Dependabot と同じ理由） | — | ADR 0008:39 |
| 23 | Developer | Backstage Auth | 認証する | GitHub OAuth（本番）、guest（ローカル） | 描かない（認証の詳細） | — | app-config.production.yaml:49-57 |
| 24 | Deploy / Destroy workflow | AWS | デプロイ・破棄 | GitHub OIDC、`terraform apply` / `destroy` | 描かない（AWS の配置。ユーザー決定） | — | deploy.yml、destroy.yml、ADR 0010 |

## 包含関係

| system boundary | 中に入る要素 | 根拠 |
| --- | --- | --- |
| idp-golden-path | Backstage（境界）、service-baseline、Reusable workflows | すべて idp-golden-path の中のファイル（`backstage/`、`backstage/templates/service-baseline/`、`.github/workflows/`） |
| Backstage（idp-golden-path の中） | Software Catalog、Software Templates（Scaffolder）、TechDocs | 1 つの backend に plugin として載る（index.ts:9-71）。1 つのイメージで配置する（backstage/packages/backend/Dockerfile） |
| 枠の外（外部の software system） | New repository、terraform-hannibal、ticket-c2c-platform、felis-ai-chatbot | C4 の System Context 図の書き方どおり、境界の外に外部の software system として置き、C4 の group（点線。所有の境界の破線と線種・色で区別。薄い背景色）で囲み、他の枠と同じく左上に `GitHub repositories [Software System]` を 1 回だけ書く（2026-11-14 ユーザー決定）。terraform-hannibal・ticket-c2c-platform は、取り込みの線を箱の左寄りから、共有の線を右寄りに入れる。いずれも github.com の `kmryst` 配下（caller workflow の `uses: kmryst/...`、app-config.yaml:119-122、`publish:github` の `repoUrl` は github.com だけを許可: template.yaml:22-74）。箱に GitHub のロゴを小さく付ける |
| 枠の外 | Developer、Platform engineer | C4 の Person |

- GitHub の枠は作らない（2026-11-03 ユーザー決定）。idp-golden-path の枠は C4 の system boundary（このシステムが提供するもの）で、GitHub の枠は置き場所による分類になり基準が混ざる。Reusable workflows と service-baseline の実体も GitHub 上の idp-golden-path リポジトリにあるため、「GitHub 枠の外 = GitHub に無い」と誤読される

## 番号付きの流れ（Software Template でリポジトリを作り、CI を動かすまで）

| 番号 | 矢印（始点 → 終点） | ラベル（1 行目 / 2 行目） | 順序の根拠 |
| --- | --- | --- | --- |
| ① | Developer → Software Templates | テンプレートの選択と実行 / `[Web browser]` | 実行手順 1〜4（scaffolder-github-integration.md:52-56） |
| ② | Software Templates → service-baseline | skeleton の展開 / `[fetch:template]` | template.yaml の steps の 1 番目（:81） |
| ③ | Software Templates → New repository | リポジトリの作成と push / `[publish:github]` | steps の 2 番目（:96） |
| ④ | Software Templates → Software Catalog | Component の登録 / `[catalog:register]` | steps の 3 番目（:110）。入力に ③ の output を使う |
| ⑤ | Reusable workflows → New repository | CI ガードレールの共有 / `[uses: @v1]` | 生成後のイベント（PR など）で caller workflow が動く。template の output の「次にやること」2（template.yaml:126-131） |

## README 用の表の下書き: reusable workflow 一覧

呼び出し方はすべて `uses: kmryst/idp-golden-path/.github/workflows/<ファイル>@<タグ>`。表の値はタグ（— は呼んでいない）。

| 名前（`name:`） | ファイル | 何を検査するか | service-baseline（生成リポジトリ） | felis-ai-chatbot | terraform-hannibal | ticket-c2c-platform |
| --- | --- | --- | --- | --- | --- | --- |
| PR Policy Check | pr-policy-check.yml | 必須ラベル 4 種、Issue への参照、厳密運用の PR のロールバック欄 | `@v1` | `@v1` | `@v1` | `@v1.7.2` |
| Commitlint | pr-commitlint.yml | コミットメッセージと PR タイトル（Conventional Commits） | `@v1` | `@v1` | `@v1` | `@v1` |
| Markdown Lint | markdown-lint.yml | Markdown（markdownlint-cli2） | `@v1` | `@v1` | `@v1` | `@v1` |
| Gitleaks Secret Scan | security-scan.yml | git 履歴の secret（gitleaks） | `@v1` | `@v1` | `@v1` | `@v1.7.2` |
| Sync Labels | sync-labels.yml | `.github/labels.yml` を GitHub のラベルへ同期（検査ではなく同期） | `@v1` | `@v1` | `@v1` | `@v1` |
| Issue Template Check | issue-template-check.yml | Issue 本文の必須見出しと必須ラベル。ラベルの補正と不備のコメント | `@v1` | `@v1` | `@v1` | `@v1` |
| Toolchain Version Check | toolchain-version-check.yml | `.mise.toml` と workflow に書いた Terraform バージョンの一致 | `@v1` | `@v1` | `@v1` | `@v1` |
| CodeQL | codeql.yml | SAST（javascript-typescript、actions）。結果は Code scanning | — | — | `@v1` | `@v1.7.2` |
| Dependency Audit | dependency-audit.yml | 依存の既知の脆弱性（npm audit / yarn npm audit、high 以上で fail） | — | — | `@v1`（2 か所） | `@v1.7.2`（2 か所） |
| Dependency Unblock Check | dependency-unblock-check.yml | Dependabot の ignore を外せるかを週次で確かめ、追跡 Issue に記録 | — | — | — | `@v1.7.2` |
| Trivy Config Scan | trivy-config.yml | IaC と Dockerfile の misconfiguration（既定は非 blocking） | — | — | — | `@v1.7.2` |
| Trivy Image Scan | trivy-image.yml | コンテナイメージの脆弱性。結果は Code scanning | — | — | — | `@v1.7.2`（2 か所） |
| （生成元） | — | — | `fetch:template` | skeleton の手動コピー | 後から取り込み | 後から取り込み |
| （Software Catalog） | — | — | `catalog:register` で登録 | 未登録 | 登録済み（url location） | 登録済み（url location） |

根拠: idp-golden-path の各 workflow の `name:` と本文（GitHub CI 担当の表 1 の行番号）、呼び出し側は各リポジトリの `.github/workflows/*.yml` の `uses:` 行。`v1` と `v1.7.2` は現時点で同じ commit。

## 突き合わせで解消した点

| 論点 | 担当間の差 | 結論と根拠 |
| --- | --- | --- |
| Scaffolder で実際に生成されたリポジトリ | 両担当とも「無い」で一致 | 一致。図では「New repository」をテンプレートの生成物として描き、実在する 3 リポジトリとは分ける。3 リポジトリに「生成する」の矢印を描かない（関係 16・17）。felis は手動コピー（felis ADR 0001:13-21）、hannibal・ticket は後から取り込み |
| 本番の `publish:github` の認証 | Backstage 担当のみ指摘（不明） | 本番の ECS タスク定義に `GITHUB_TOKEN` が無いことを確認（terraform/ephemeral/ecs.tf:116-147 の `environment` / `secrets`）。app-config.production.yaml も `integrations` を上書きしない。手順書はローカル用だけ（scaffolder-github-integration.md:1）。→ ① 〜 ④ の流れは**ローカルの Backstage で動く実装**として描き、本番で動くかは「不明」に残す。図は環境を描かないので影響しない |
| ADR 0006 / template の README と実装の食い違い | Backstage 担当のみ指摘 | 実装が正。`.github/actions/` はリポジトリにも skeleton にも無く（`ls`）、template.yaml:86-88 の `copyWithoutTemplating` は `.github/workflows/**` と `scripts/github/**` だけ。skeleton の caller workflow は 7 本（ADR 0006:19 の「5 本」は後で Issue Template Check・Toolchain Version Check が増えた前の数。#47 など）。図・README は実装の 7 本に合わせる。文書の修正は別 Issue の候補 |
| reusable workflow の数 | Backstage 担当は skeleton の 7 本だけ、CI 担当は 12 本 | 12 本。`on: workflow_call` を持つ workflow を数えた（codeql、dependency-audit、dependency-unblock-check、issue-template-check、markdown-lint、pr-commitlint、pr-policy-check、security-scan、sync-labels、toolchain-version-check、trivy-config、trivy-image）。trivy-image-selftest と workflow-input-contract は本文のコメントに `workflow_call` の語があるだけで、`on:` には無い |
| 呼び出し側ごとの範囲とバージョン | 両担当で一致（CI 担当が詳細） | ローカルの作業ツリーで再確認して一致。felis 7 種すべて `@v1`、hannibal 9 種 10 回すべて `@v1`、ticket 12 種 14 回（`@v1` 5 種、`@v1.7.2` 7 種）。表は上の README 用の表 |
| felis の Software Catalog 登録 | 両担当とも「未登録」 | 一致。`origin/main` に `catalog-info.yaml` が無く、app-config の locations にも無い。図で Software Catalog → felis の矢印を描かない |
| 人の役割の語 | Backstage 担当は表 4 で「SVG にしかない」、表 2 では「既存の図と org.yaml の語」と書いていて報告内で矛盾 | `Platform Engineer` は catalog/org.yaml:7 にある（SVG だけではない）。`Application Engineer` は既存の SVG にしかない。→ Backstage 公式の Benefits の語に合わせ、`Platform engineer`（公式「For platform engineers」、org.yaml と一致）と `Developer`（公式「For end users (developers)」）にする。`Application Engineer` は使わない |
| caller workflow の生成と登録の順序 | 両担当で一致 | template.yaml の steps 順（fetch → publish → register）を確認。④ は ③ の output を入力に使うので順序は固定 |

## 不明点

| 項目 | 不明な理由 | 関連ファイル |
| --- | --- | --- |
| 本番で Scaffolder の `publish:github` が動くか | 本番に `GITHUB_TOKEN` を渡す設定が無く、本番で実行した記録も無い | backstage/app-config.yaml:55、terraform/ephemeral/ecs.tf:116-147 |
| Scaffolder でリポジトリを作った実績（ローカルを含む） | 検証記録（docs/operations/verification/）に Scaffolder の実行記録が無い | docs/operations/verification/、docs/operations/scaffolder-github-integration.md |
| 本番で Catalog・TechDocs が表示されること | 検証記録で未完了（実ユーザーでのログイン後の確認なし） | docs/operations/verification/2026-07-08-production-deploy/README.md:37-56 |
| 生成リポジトリの TechDocs のビルド | 生成リポジトリの `techdocs-ref: dir:.` を url location 経由でビルドした記録が無い | skeleton/catalog-info.yaml:9、app-config.yaml:73-80 |
| リモートの `v1` が今どこを指すか、GitHub Releases の有無 | fetch していない。リリース用 workflow は無い | ADR 0008:27-36 |
| reusable の Gitleaks Secret Scan が呼び出し側の `.gitleaks.toml` を読むか | `--config` を渡しておらず、docs に記述が無い | .github/workflows/security-scan.yml:59 |
| ローカルの Search engine（pg module と SQLite の組み合わせ） | 挙動の記述が無い（図には描かない） | backstage/packages/backend/src/index.ts:55、app-config.yaml:39-41 |
| ticket の `@v1.7.2` 固定を `@v1` に戻すか | ticket 側で未決 | kmryst/ticket-c2c-platform:docs/operations/github-flow-guardrails.md:29 |

## 図の規模の見積もり（README 幅 1000px、最小文字 12px）

- 描く要素: 11（Person 2、Backstage の中の Component 3、service-baseline、Reusable workflows、リポジトリ 4）。境界 2（idp-golden-path、Backstage）
- 描く関係: 12（番号付き 5、その他 7）
- 見積もり（作図前。GitHub の枠をやめる決定の前の案で、実際の配置は gen.py）: 左から Person → idp-golden-path → GitHub の 3 列。GitHub の枠にリポジトリ 4 つを縦に並べ、Reusable workflows への `uses:` 4 本が平行に走る。箱の幅 160〜180px・文字 14px で横 1000px 前後に収まる見込み
- 混む場合に「描かない」へ回す候補（優先順）: 関係 11（Developer → Software Catalog の閲覧）、関係 12・13（Platform engineer → idp-golden-path / Reusable workflows）、TechDocs の箱（2026-11-14 に Software Catalog → TechDocs の線を足したので候補から外れた）。`uses:` の 3 本（6〜8）は描く（呼び出し側の実在を示す主題のため）
