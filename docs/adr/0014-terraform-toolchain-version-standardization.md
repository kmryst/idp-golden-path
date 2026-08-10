# 0014. Terraform ツールチェーンのバージョンを 3 リポジトリで 1.14.8 に統一し、ローカル正本と CI pin の整合性を CI で検査する

## ステータス

Accepted

## 日付

2026-08-10

## 決定内容

kmryst 配下の 3 リポジトリ（`idp-golden-path` / `terraform-hannibal` / `ticket-c2c-platform`）の Terraform CLI バージョンを **1.14.8 に統一**する。

- 各リポジトリのリポジトリルートに `.mise.toml` を置き、これを**ローカル実行環境のツールチェーンバージョンの正本**とする
- CI（GitHub Actions）は `.mise.toml` を読まず、workflow 内で明示的にバージョンを pin する。pin の値は `.mise.toml` の宣言と**一致させる**
- 両者の一致は人間の注意力に任せず、**reusable workflow `toolchain-version-check.yml` が PR ごとに機械検査**する。本リポジトリが配布元となり、他 2 リポジトリは `uses: kmryst/idp-golden-path/.github/workflows/toolchain-version-check.yml@v1` で consume する（配布方式は [ADR 0008](./0008-ci-guardrails-as-reusable-workflows-with-tag-pinning.md)）
- `.mise.toml` には、そのリポジトリで実際に使うツールだけを宣言する。使っていないツールを「揃えるため」に宣言しない
- Scaffolder の service-baseline skeleton にも `.mise.toml` と caller workflow を含め、新規生成リポジトリが最初からこの型に乗るようにする

### 本リポジトリでの具体値

| 対象 | 値 |
| --- | --- |
| `.mise.toml` の `terraform` | `1.14.8` |
| `.mise.toml` の `node` | `24.18.0` |
| `deploy.yml` / `destroy.yml` の `TERRAFORM_VERSION` | `1.14.8` |

`tflint` / `terraform-docs` / `pre-commit` は本リポジトリでは使っていないため宣言しない。Yarn 4 は Corepack（`backstage/package.json` の `packageManager`）が版を決めるため mise では宣言しない。

### 検査の契約

- 検査対象は `.mise.toml` の `[tools] terraform` と、workflow ファイル中の `TERRAFORM_VERSION:` / `terraform_version:` の**リテラル値**。`terraform_version: <式による env 参照>` のような間接参照は「実体ではなく参照」なので pin とみなさない
- `.mise.toml` のパス（`mise-config-path`）と検査対象ファイルの glob（`workflow-paths`、改行区切り）は input で上書きできる。リポジトリごとに workflow の構成が違うため
- `.mise.toml` が存在しない場合は **skip せず fail** する
- `.mise.toml` に Terraform 宣言がないのに CI に pin がある場合も fail する。正本のないバージョンが CI にだけ存在する状態を許すと、drift の起点になる
- 宣言も pin も無い場合（Terraform を使わないリポジトリ）は pass する
- 不一致時は「どのファイルの何行目が何になっていて、`.mise.toml` は何を宣言しているか」をエラーと Job Summary に出す
- Dependabot PR も免除しない

## 背景

### 実測で判明した分裂

2026-08-10 に 3 リポジトリのリモート state 全 13 件の `terraform_version` を実測した。

| リポジトリ | 層 / workspace | `terraform_version` | resources |
| --- | --- | --- | --- |
| idp-golden-path | `ipam` | 1.12.1 | 0 |
| idp-golden-path | `persistent` | **1.14.8** | 23 |
| idp-golden-path | `ephemeral` | 1.12.1 | 0 |
| terraform-hannibal | `foundation` | **1.14.8** | 57 |
| terraform-hannibal | network / database / service / cdn / observability | 1.12.1 | 0（各層） |
| ticket-c2c-platform | bootstrap / dev / staging | **1.14.8** | — |

CI の pin は次のとおりで、state と食い違っていた。

- idp-golden-path: `deploy.yml` / `destroy.yml` の `TERRAFORM_VERSION` が `1.12.1`
- terraform-hannibal: 1.12.1（`pr-check.yml` は直書き、deploy / destroy は env 経由）
- ticket-c2c-platform: 9 ファイルすべてに `terraform_version: "1.14.8"` を直書き

層ごとにバージョンが割れているのは設計判断ではない。CI 経由で実行したか手動で実行したかによって、たまたま使われた CLI が違っただけの事故である。

### state の前方非互換という制約

Terraform の state は前方互換がなく、記録された `terraform_version` より**古い CLI での操作を拒否**する。実リソースを持つ state（idp-golden-path `persistent` 23 件 / terraform-hannibal `foundation` 57 件 / ticket-c2c-platform 3 件）が既に 1.14.8 に上がっているため、1.12.1 へ戻すことは実質不可能である。

### 更新経路が失われていた層

idp-golden-path の `persistent` 層は、CI（`deploy.yml` / `destroy.yml`）の対象外で、ローカルからの手動 apply のみで運用している（[ADR 0010](./0010-ci-driven-deploy-destroy-workflows.md)）。その state は 1.14.8 だが、ローカル CLI は 1.12.1 だった。つまり **CI からも手元からもこの層を更新できない**状態が成立していた。実リソース 23 件を抱えたまま更新経路が消えていたことになる。

### drift 検知の不在

terraform-hannibal の ADR 0023 は「`.mise.toml` をローカル正本とし、CI は明示 pin する」と決め、短所として version drift リスクを挙げていた。今回そのリスクが現実化していた。同リポジトリの `.mise.toml` は terraform 1.12.1 を宣言していたが、mise 自体が導入されておらず宣言に強制力がなく、実際には apt でインストールされた 1.14.8 が使われ、`foundation` の state が 1.14.8 へ上がっていた。

宣言と実効値の乖離を機械検査していなかったため、誰も気付けなかった。ADR 0023 が予見していたリスクに対して、検知手段だけが用意されていなかったことになる。

なお idp-golden-path の reusable workflow 9 本を調べた時点で、Terraform CLI を setup する箇所は `deploy.yml` / `destroy.yml` の 2 つだけで、golden path として Terraform バージョンを標準化する仕組みは存在しなかった。skeleton にも `.mise.toml` / `.tool-versions` は含まれておらず、ツールチェーン配布の仕組み自体が未整備だった。

## 検討した選択肢

### 案 A: 1.12.1 に揃える

CI pin の変更だけで済み、既存の CI 実績（1.12.1 での実行）をそのまま踏襲できる。

しかし ticket-c2c-platform の state 3 件、terraform-hannibal の `foundation`（実リソース 57 件）、idp-golden-path の `persistent`（実リソース 23 件）が既に 1.14.8 で記録されており、前方非互換のため 1.12.1 では操作できない。実行するには state ファイル内の `terraform_version` を手で書き換える必要があり、実リソース 80 件を抱えた state に対する手動編集は復旧不能な破壊のリスクを伴う。

### 案 B: リポジトリごとに異なるバージョンを許容する

グローバル既定を置き、リポジトリ別に `.mise.toml` で上書きする。各リポジトリの現状をそのまま追認できるため、移行コストがゼロになる。

しかしこれは現状の歪みを「仕様」として固定化するだけで、次の問題が残る。

- terraform-hannibal 内でも層ごとにバージョンが割れており、「リポジトリ単位」の粒度では表現できない
- idp-golden-path `persistent` / terraform-hannibal `foundation` の更新経路が無いという実害が解消しない
- 3 リポジトリを横断して同じ運用ルールを配布する golden path の役割と矛盾する
- どのバージョンが「意図された値」なのか分からないままなので、drift の検査基準が定義できない

### 案 C（採択）: 1.14.8 に統一し、CI で整合性を検査する

3 リポジトリ・全層を 1.14.8 に揃え、`.mise.toml` をローカル正本、CI pin をその写像として、両者の一致を CI で機械検査する。

## 採択理由

- state の前方非互換という制約が選択肢を実質的に一つに絞っている。1.14.8 は「良いから選んだ」のではなく、**実リソースを持つ state が既にそこにいるから、そこしか行き場がない**（案 A の却下理由）
- ダウングレードに必要な state の手動書き換えは、実リソース 80 件に対する操作としてリスクが割に合わない。バージョンを揃えるという可逆な作業のために、不可逆な破壊リスクを取るべきではない
- 案 B は移行コストが最小だが、「更新経路が存在しない層」という実害を残したまま現状を追認する。ポートフォリオとして「事故を仕様に格上げした」記録が残るのは、技術的にも説明としても筋が悪い
- 今回の事故の本質はバージョンの値ではなく、**宣言と実効値の乖離を誰も検知できなかったこと**にある。値を揃えるだけでは同じ事故が再発するため、検査の自動化を決定に含める。ADR 0023 が短所として認識していたリスクに対して、検知手段を後から補う位置づけになる
- ローカル正本を `.mise.toml`、CI を明示 pin とする二重管理を維持するのは、CI に mise のインストール手順を持ち込むと GitHub Actions の setup アクション（`hashicorp/setup-terraform` / `actions/setup-node`）のキャッシュや実績を捨てることになるため。二重管理の唯一の欠点である drift を CI 検査で潰せるなら、この構成が最も安価である
- 検査を reusable workflow として本リポジトリから配布するのは、3 リポジトリに同じロジックをコピーすると乖離するという ADR 0008 と同じ理由による

## 影響

### 本リポジトリ

- `.mise.toml` を新規追加した。ローカルでの Terraform / Node.js のバージョンはここが正本になる。`mise install` で取得する
- `deploy.yml` / `destroy.yml` の `TERRAFORM_VERSION` を 1.12.1 → 1.14.8 に変更した。この 2 workflow は 2026-08-10 時点で一度も実行実績がない（`gh run list` が 0 件）ため、既存の実行との互換性を壊す変更にはならない
- 全 root module（`ipam` / `ephemeral` / `persistent`）が Terraform 1.14.8 で `fmt -check -recursive` / `init -backend=false` / `validate` を通ることをローカルで実測確認した。`fmt -check` の結果は 1.12.1 と 1.14.8 で同一（どちらも差分なし）であり、CI を 1.14.8 に上げても既存コードが Format チェックで落ちることはない。`.terraform.lock.hcl` の変更も発生しなかった
- `persistent` 層はローカルからの手動 apply のみで運用するため、ローカル CLI が 1.14.8 になることで**更新経路が回復**する。これが今回の変更の実質的な効果である
- `toolchain-version-check.yml` は dual-trigger（`pull_request` + `workflow_call`）であり、本リポジトリ自身の PR チェックを兼ねる。新規ガードレールのため required status checks には**即座には追加しない**（段階的 required 化の方針は [ADR 0008](./0008-ci-guardrails-as-reusable-workflows-with-tag-pinning.md) 追記と同じ）

### 消費側リポジトリ

- 消費側は `.mise.toml` の追加、CI pin の 1.14.8 への更新、caller workflow の追加を同じ PR で行う。`.mise.toml` 不在を fail としているため、caller だけ先に入れると CI が落ちる
- 消費側の check run 名は `toolchain-version-check / Toolchain Version Check` になる（caller job に `name:` を付けず job id にフォールバックさせる規約。ADR 0008 追記 2026-07-13）
- caller の `concurrency.group` は callee と同一にしてはならない。`toolchain-version-check-caller-<PR番号>` のように `-caller` サフィックスを付ける
- terraform-hannibal は `pr-check.yml` に `terraform_version` が直書きされているため、`workflow-paths` の既定値（`.github/workflows/*.yml` / `*.yaml`）でそのまま検出できる
- ticket-c2c-platform は 9 ファイルに直書きだが、既に全て 1.14.8 のため、`.mise.toml` の追加と caller の追加だけで pass する見込み

### 本 ADR と terraform-hannibal ADR 0023 の関係

terraform-hannibal の ADR 0023 は「`.mise.toml` をローカル正本、CI は明示 pin」を同リポジトリの決定として採択している。本 ADR はその決定を **3 リポジトリ共通の標準へ昇格させ、ADR 0023 が短所として挙げていた version drift リスクに対する検知手段を追加**するものである。

ADR 0023 は別リポジトリの ADR であるため、本 ADR が supersede することはできない。terraform-hannibal 側の ADR 0023 の扱い（追記するか、後続 ADR で更新するか）は同リポジトリの移行 Issue / PR で判断する。

### Scaffolder skeleton

- skeleton に `.mise.toml`（node のみ宣言。Terraform を使うときの標準値はコメントで案内）と caller workflow を追加した。新規生成リポジトリにのみ影響し、既存の生成済みリポジトリには影響しない

## 検証

検査そのものが機能していることは、3 リポジトリに意図的な drift を仕込んだ使い捨ての Draft PR で実測した（2026-08-10）。
一致検査は対象ファイルを 1 件も拾えていなくても導入 PR では緑になるため、
「落ちるべきときに落ちる」ことを確認しなければ検知手段として成立しない。

実測で確認できたこと。

- `.mise.toml` 側 / workflow の pin 側の**両方向**の drift を、3 リポジトリすべてで検出する
- 検出漏れゼロ（列挙数が事前に grep した pin の実在数と一致。ticket-c2c-platform では 9 件）
- 誤検知ゼロ（`terraform_version: ${{ env.TERRAFORM_VERSION }}` のような間接参照行を pin とみなさない）
- caller 経由でも配布元自身と同じ判定・同じメッセージになる

実 CI では未確認のまま残っているのは、`.mise.toml` 不在時の fail と TOML 解析失敗時の fail の 2 経路である
（ローカルのフィクスチャ検証のみ）。

run ID・仕込んだ drift・出力されたメッセージの実例は
[検証記録 2026-08-10](../operations/verification/2026-08-10-toolchain-version-check/README.md) に残す。

## 再検討条件

- **Terraform の新しいメジャーバージョンが出た場合**（2.x など）。state 互換性・provider 互換性・CI の setup アクション対応状況を確認し、統一先バージョンを更新するかを判断する
- **state の互換性方針が変わった場合**。Terraform が state の前方互換を保証するようになれば、「行き場が一つしかない」という前提が崩れ、バージョン選択の自由度が戻る
- **1.14.8 に固有の不具合が判明した場合**。その場合の移行先は 1.14.x の patch 上位であり、ダウングレードではない（前方非互換の制約は変わらない）
- **`.mise.toml` 以外のツールチェーン宣言方式へ移行する場合**（`.tool-versions` / devcontainer / Nix など）。検査対象のパーサを差し替える必要がある
- **CI が mise を直接使う構成へ移行した場合**。ローカル正本と CI pin の二重管理そのものが不要になり、本 ADR の検査も役目を終える

## 関連

- Issue: [kmryst/idp-golden-path#174](https://github.com/kmryst/idp-golden-path/issues/174)
- [ADR 0008. CI ガードレールを reusable workflows として提供し、タグ固定（`@v1`）で参照する](./0008-ci-guardrails-as-reusable-workflows-with-tag-pinning.md)
- [ADR 0009. 本番デプロイは ECS Fargate + Aurora Serverless v2 + GitHub OAuth とし、検証時のみ apply する 3 層 state 分離で運用する](./0009-production-deployment-on-ecs-fargate.md)
- [ADR 0010. 本番デプロイ / 破棄は workflow_dispatch の GitHub Actions で実行する](./0010-ci-driven-deploy-destroy-workflows.md)
- kmryst/terraform-hannibal ADR 0023（`.mise.toml` をローカル正本とし CI は明示 pin する）
- [Terraform Docs: State — version compatibility](https://developer.hashicorp.com/terraform/language/state)
- [mise: Configuration](https://mise.jdx.dev/configuration.html)
