# GitHub Flow Guardrails

`idp-golden-path` の GitHub フローを、Internal Developer Platform のリファレンス実装として育てながら、少人数運用でも重くしすぎないための設計意図をまとめた文書です。

運用ルールの正本は [CONTRIBUTING.md](../../CONTRIBUTING.md) です。この文書では、採用方針の理由、未採用案、将来の再検討条件を補足します。
採用判断の履歴は [ADR 0002](../adr/0002-adopt-lightweight-and-strict-github-flow.md)、現在の branch protection 設定は [branch-protection.md](./branch-protection.md) を参照します。

## 3 リポジトリ間の位置づけ

時系列では、`idp-golden-path` は `terraform-hannibal` / `ticket-c2c-platform` より後に作られたプロジェクトです。
ただし役割としては、既存 2 リポジトリで実証した Issue / PR 駆動、AI Agent 運用、CI ガードレール、ADR 運用を抽象化し、golden path として配布・標準化するリポジトリです。

したがって、3 リポジトリ全体の見え方としては、`idp-golden-path` が運用ガードレールの雛形・配布元・標準化元になり、`terraform-hannibal` / `ticket-c2c-platform` はその型へ収束させていく方針です。
これは歴史を「idp-golden-path から最初に作った」と書き換えるものではなく、実証済み運用を IDP の golden path として抽象化した現在の構造を明確にするものです。

## 現時点の技術的な未収束点

2026-07-13 時点では、`idp-golden-path` は reusable workflow と service baseline skeleton の配布元になっていますが、既存 2 リポジトリの技術実装はまだ完全には収束していません。

- `terraform-hannibal` / `ticket-c2c-platform` は、PR Policy Check / Commitlint / Gitleaks / Sync Labels などを `uses: kmryst/idp-golden-path/.github/workflows/<file>.yml@v1` で消費する薄い caller workflow へまだ移行していない。
- そのため、消費側の required status check 名は service baseline skeleton が想定する `PR Policy Check / PR Policy Check` などの合成名ではなく、既存の単体名を前提としている。
- Markdown Lint / Issue Template Check など、service baseline skeleton が持つ共通 CI ガードレールは 3 リポジトリで未導入または未整合である。導入や required 化は、運用負荷を見て別 Issue で判断する。
- helper scripts は共通化途上であり、消費側リポジトリは `scripts/github/lib/common.sh` 形式にまだ揃っていない。
- deploy / destroy、Terraform apply、backend / frontend build、smoke test などのドメイン固有 workflow は、各リポジトリ固有の責務として残す。

## 目的

- `Issue -> Branch -> PR -> Merge -> cleanup` を、IDP のゴールデンパスとして自分自身でも実践する
- AI Agent / CLI / API を使っても、Issue / PR の品質と変更追跡が崩れないようにする
- Backstage 本体、Scaffolder template、CI ガードレール、Terraform を同じ運用モデルで扱う
- reusable workflow や skeleton へ横展開する運用ルールの理由を、手順の正本から分離して残す

## 設計原則

- 手順と必須項目は `CONTRIBUTING.md` を正本とする
- branch protection の現在設定は `docs/operations/branch-protection.md` を正本とする
- この文書は正本を置き換えず、理由・未採用案・再検討条件を記録する
- 軽運用でも Issue / Branch / PR は省略しない
- IDP 自体が配布するガードレールは、自リポジトリでも同じ品質で運用する

## 採用方針

### 共通ガードレール

- `main` への direct push は禁止し、作業ブランチから PR を経由する
- Issue と PR は `type / area / risk / cost` の必須ラベルを持つ
- PR 本文には `Closes / Fixes / Refs #<issue番号>` のいずれかを含める
- Issue 本文の最小項目は `目的 / 対象 / 受け入れ条件` とする
- Issue / PR 作成は helper を正規ルートとする
- PR は通常 PR として作成し、draft PR にはしない
- PR マージ後、次の Issue へ進む前に cleanup helper で作業ブランチを整理する

### 軽運用 / 厳密運用

軽運用は、README / docs の軽微な更新、コメントや文言修正、影響範囲が限定的な低リスク変更を想定します。
軽運用でも `Issue -> Branch -> PR` は維持します。

厳密運用は、次のような変更を想定します。

- `risk:medium/high`
- `cost:medium/large`
- `.github/workflows/**`
- `scripts/github/**`
- `terraform/**`
- branch protection などリポジトリ設定の変更
- AWS リソース、IAM、OIDC、Secrets、Network、Security に関わる変更
- Backstage の認証・権限（auth / permission）に関わる変更
- deploy / destroy に関わる変更
- ロールバックを考える必要がある変更

厳密運用 PR では、`ロールバック` に実質的な内容を書きます。見出しだけではなく、何を戻すか、どう戻すかが分かる最低限の説明を求めます。

### AI Agent 運用

- AI Agent は Issue 起票前に Issue プランを提示する
- ブランチを切った後、実装前に変更対象・変更内容・影響範囲を含む計画を提示する
- PR 作成前に PR プランを提示する
- ユーザーから依頼されても `main` へ direct push しない
- PR helper には埋めた PR body のコピーを渡し、テンプレート原本をそのまま渡さない
- 作業ブランチは push してよいが、PR は作成前プランを提示してから作成する

この流れは、AI Agent の速度を殺すためではなく、IDP が配布する運用ガードレールの実例として、意図・影響範囲・リスク認識を PR 前に揃えるためのものです。

### PR 品質ゲート

現在の required status checks は `docs/operations/branch-protection.md` を正本とします。

現時点では次の check を required として扱います。

- `PR Policy Check`
- `Commitlint`
- `Markdown Lint`
- `Gitleaks Secret Scan`

`Backstage CI` は `backstage/**` の paths filter 付き workflow のため、現時点では required にしません。paths filter 付き workflow を required 化すると、該当 path を触らない PR で check run が作られず、PR が永久に pending になるためです。

Dependency Audit / CodeQL などの追加 security signal は、検出頻度と運用負荷を見てから required 化を判断します。

### reusable workflow / skeleton への横展開

このリポジトリは CI ガードレールを reusable workflows として提供し、Scaffolder template でも運用ベースラインを配布します。

そのため、次の変更では自リポジトリの動作だけでなく、消費側リポジトリや skeleton への影響も確認します。

- `.github/workflows/**`
- `scripts/github/**`
- `AGENTS.md`
- `CLAUDE.md`
- `CONTRIBUTING.md`
- `.github/labels.yml`
- Issue / PR template

workflow job 名を変える場合は、本リポジトリの required status checks だけでなく、消費側リポジトリの check run 名にも影響します。破壊的変更は ADR 0008 のバージョニング方針に従います。

## 未採用案と理由

### `main` への直接 push

採用しません。

理由:

- ゴールデンパスとして示したい Issue / PR 駆動の実例にならない
- 変更意図、影響範囲、CI 結果を PR に残せない
- AI Agent の変更がレビュー境界なしに `main` へ入る

### approval 常時必須

現時点では採用しません。

理由:

- ひとり開発では形式的な承認になりやすい
- PR 必須、必須 CI、Issue link、ラベル、事前計画確認で最低限の品質を担保できる
- 将来の複数人運用に移った時点で再検討できる

### Backstage CI の required 化

現時点では採用しません。

理由:

- `Backstage CI` は `backstage/**` の paths filter 付きで、docs のみ PR では check run が作られない
- required にすると、無関係な PR が pending のままマージ不能になる
- Backstage 関連 PR では workflow が実行されるため、少人数運用では目視確認で足りる

### draft PR を標準にする

採用しません。

理由:

- ひとり開発では `gh pr ready` の追加操作が運用負担になりやすい
- PR 作成前にプラン確認を挟むため、作成後に draft で止める価値が小さい
- 作りかけの共有が必要な場合だけ、個別に draft を選べばよい

### CODEOWNERS 即導入

現時点では採用しません。

理由:

- 現状は領域オーナーを分ける実益が薄い
- 少人数運用では、CODEOWNERS よりも PR plan と required checks の方が効く

## 将来の再検討条件

### approval 必須化

- 常時レビュー担当が 2 名以上いる
- IDP を継続運用し、利用者影響のある変更が増える
- Terraform / Security / Backstage auth 変更を相互レビューできる体制になる

### CODEOWNERS

- `backstage/**`、`terraform/**`、`.github/workflows/**`、Security などの領域責任者が分かれる
- reusable workflows や skeleton の変更レビュー責任を GitHub 上で明示する価値が運用コストを上回る

### Backstage CI required 化

- `backstage/**` の変更頻度が上がる
- no-op ペア workflow 方式など、paths filter と required status check の衝突を避ける方式を採用する
- Backstage 本体の build/test 失敗を PR 上で必ず止める価値が運用コストを上回る

### PR 品質ゲートの変更

- workflow job 名を変える
- required status check に新しい check を追加する
- reusable workflow の interface を変える
- GitHub branch protection 設定を変える

これらは自リポジトリだけでなく、生成されるリポジトリや reusable workflow 消費側にも影響し得るため、変更時は docs、branch protection、skeleton への追従要否を同じ Issue / PR で扱います。
