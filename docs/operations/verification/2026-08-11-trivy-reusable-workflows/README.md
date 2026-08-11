# Trivy reusable workflows 検証記録 (2026-08-11)

`trivy-image.yml` / `trivy-config.yml`（[Issue #181](https://github.com/kmryst/idp-golden-path/issues/181) /
[PR #182](https://github.com/kmryst/idp-golden-path/pull/182)、設計判断は
[ADR-0008 追記 2026-08-11](../../../adr/0008-ci-guardrails-as-reusable-workflows-with-tag-pinning.md)）の実測記録である。

導入 PR が緑になったことは「機能している証拠」にならない。
特に本件は、`exit-code` の既定が `'0'`（非 blocking）であるため、
**検出できていなくても緑になる**という構造を最初から持っている。
そこで、落ちるべき条件・消えるべき結果を意図的に作って実測した。

ネガティブテストは、PR #182 のブランチから派生させた**使い捨ての Draft PR** 3 本で行った。
いずれも `main` にマージせず、検証後にクローズしてブランチを削除している
（[#183](https://github.com/kmryst/idp-golden-path/pull/183) /
[#184](https://github.com/kmryst/idp-golden-path/pull/184) /
[#185](https://github.com/kmryst/idp-golden-path/pull/185)）。

`workflow_dispatch` による検証は使えなかった。`workflow_dispatch` は
**workflow ファイルが default branch に存在しないと起動できない**ため、
未マージの新規 workflow には適用できない。`pull_request` トリガーで動く使い捨て PR を使ったのはこのためである。

## 結果一覧

| # | 検証項目 | 方法 | 実測結果 |
| --- | --- | --- | --- |
| 1 | reusable workflow が caller 経由で実際に動く | PR #182 の `trivy-image-selftest.yml`（`uses: ./.github/workflows/trivy-image.yml`） | `primary / Trivy Image Scan` 30s / `secondary / Trivy Image Scan` 35s、いずれも success（[run 31470151790](https://github.com/kmryst/idp-golden-path/actions/runs/31470151790)） |
| 2 | image scan が実際に finding を出す | 同上の artifact を取得して集計 | primary 29 件（CRITICAL 6 / HIGH 23、修正版あり 7）、secondary 29 件（CRITICAL 5 / HIGH 24） |
| 3 | SARIF の category 分離が効く | #183: `upload-sarif: true`・`image-name` を別々に | analyses 2 件（`trivy-image-selftest-primary` 29 / `trivy-image-selftest-secondary` 29）、**open alerts 51 件**。両方が残る |
| 4 | category を衝突させると片方が消える（ネガティブ） | #184: 2 job とも `image-name: selftest-primary` | analyses は 2 件とも同一 category で results=29 だが、**open alerts は 29 件**。後の upload が前を上書きし、片方の結果が消えた |
| 5 | `exit-code: '1'` で fail する | #184: 2 job とも `exit-code: '1'` | `primary / Trivy Image Scan` fail（37s）/ `secondary / Trivy Image Scan` fail（41s） |
| 6 | `exit-code: '0'` は finding があっても success | PR #182 / #183（29 件検出） | いずれも success |
| 7 | 必須 input の省略（ネガティブ） | #185: `image-name` を省略した使い捨て caller | run が **STARTUP_FAILURE**。job は 1 つも作成されない |
| 8 | caller の permissions 不足（ネガティブ） | #185: caller job から `security-events: write` を外す | run が **STARTUP_FAILURE**。job は 1 つも作成されない |
| 9 | inputs の既定値が効く | PR #182 は `dockerfile` / `severity` / `trivy-version` を渡していない | `--file scripts/ci/fixtures/trivy-image/primary/Dockerfile`（`<docker-context>/Dockerfile` へ解決）、Trivy `v0.70.0`、`CRITICAL,HIGH` で 29 件を実測 |
| 10 | config scan が実際に finding を出す | PR #182 の `Trivy Config Scan` | **10 件**（CRITICAL 3 / HIGH 7）、job 11 秒。全件 `terraform/` 配下 |
| 11 | `type=gha` のビルドキャッシュ | 同一ブランチで 2 回実行し build ログを確認 | 2 回目に `#6 importing cache manifest from gha:...` / `#9 exporting to GitHub Actions Cache` を確認。**所要時間の差は測定できず**（後述） |

## 1. SARIF の category 分離（項目 3 / 4）

もっとも重要な検証である。同一リポジトリから複数の SARIF を上げるとき、
`github/codeql-action/upload-sarif` の `category` を分けないと後の upload が前を上書きする。

`code-scanning/analyses` API で ref ごとに実測した。

### category を分けた場合（#183）

```text
trivy-image-selftest-primary   | results=29 | 2026-08-11T07:47:34Z
trivy-image-selftest-secondary | results=29 | 2026-08-11T07:47:12Z
→ open alerts: 51 件
```

### category を衝突させた場合（#184）

```text
trivy-image-selftest-primary | results=29 | 2026-08-11T07:47:13Z
trivy-image-selftest-primary | results=29 | 2026-08-11T07:47:07Z
→ open alerts: 29 件
```

analyses は 2 件とも記録されるが、**alert は後勝ちで 1 イメージ分しか残らない**。
実際に #184 に残った alert は `util-linux 2.41-5`（Debian trixie = secondary 由来）を含み、
primary（bookworm）固有の finding は消えていた。

51 という数は「29 + 29 − 両イメージで重複する 7」に対応する
（CVE ID とパッケージ名で突き合わせると primary / secondary の共通は 27 件だが、
alert は検出箇所ごとに立つため件数は一致しない。重要なのは 51 と 29 の差である）。

この挙動があるため、`trivy-image.yml` は `image-name` を**必須 input**にし、
`category: trivy-image-<image-name>` を強制している。

## 2. exit-code（項目 5 / 6）

同じフィクスチャ・同じ finding 件数（29 件）で、`exit-code` だけを変えて比較した。

| PR | `exit-code` | finding | job の結果 |
| --- | --- | --- | --- |
| #182 / #183 | `'0'`（既定） | 29 件 | success |
| #184 | `'1'` | 29 件 | fail（`Trivy image scan found 29 vulnerabilities (exit-code=1)`） |

判定は Trivy の終了コードではなく、JSON を集計した件数に基づく最終 step
（`Enforce exit code`）で行っている。これにより `exit-code: '1'` でも
Step Summary・artifact・SARIF がすべて残り、「何が原因で落ちたか」を後から追える。

## 3. 入力ミスの落ち方（項目 7 / 8）

どちらも **run 全体が `STARTUP_FAILURE`** になり、job は 1 つも作成されない。
つまり「check が緑のまま素通りする」ことはない一方、
**GitHub Actions の check run としては何も現れない**ため、caller 側の設定ミスは
PR の check 一覧ではなく Actions タブで気づくことになる。エラーメッセージは Actions の UI にのみ表示され、
REST API（`actions/runs/<id>/jobs`、`commits/<sha>/check-runs`）からは取得できなかった。

必須 input の省略はローカルの `actionlint` で事前に検出できる。

```text
.github/workflows/zz-verify-missing-input.yml:19:11: input "image-name" is required by
"./.github/workflows/trivy-image.yml" reusable workflow [workflow-call]
```

permissions 不足は `actionlint` では検出できなかったため、消費側の caller を書くときは
**`security-events: write` の付与を必ず目視確認する**必要がある
（`upload-sarif: false` で呼ぶ場合も付与が必要）。

## 4. config scan（項目 10）

PR #182 の `Trivy Config Scan` は 10 件（CRITICAL 3 / HIGH 7）を検出した。内訳:

| ルール | 件数 | ファイル |
| --- | --- | --- |
| AWS-0104 A security group rule should not allow unrestricted egress to any IP address.（CRITICAL） | 3 | `terraform/ephemeral/network.tf` |
| AWS-0164 Instances in a subnet should not receive a public IP address by default. | 2 | `terraform/ephemeral/network.tf` |
| AWS-0079 RDS Cluster の暗号化 | 1 | `terraform/ephemeral/aurora.tf` |
| AWS-0052 Load balancers should drop invalid headers | 1 | `terraform/ephemeral/ecs.tf` |
| AWS-0053 Load balancer is exposed to the internet. | 1 | `terraform/ephemeral/ecs.tf` |
| AWS-0031 ECR images tags shouldn't be mutable. | 1 | `terraform/persistent/main.tf` |
| AWS-0132 S3 encryption should use Customer Managed Keys | 1 | `terraform/persistent/main.tf` |

いずれも未棚卸しで accepted risk 候補を含むため、`exit-code` は `'0'` のままとする（ADR-0008 追記 2026-08-11）。
`backstage/packages/backend/Dockerfile` は HIGH / CRITICAL を 1 件も出していない（`USER node` を宣言しているため）。

### 副産物: 自分で追加した Dockerfile を実際に検出した

最初のコミットでは検出件数が **12 件**で、うち 2 件は今回追加したフィクスチャ
（`scripts/ci/fixtures/trivy-image/{primary,secondary}/Dockerfile`）の
`DS-0002 Image user should not be 'root'` だった。
`trivy config` が「その PR で新しく追加された Dockerfile」を実際に拾えていることの実測でもある。
フィクスチャ側に `USER node` を足して 10 件に戻した
（ローカルで `git archive HEAD` した clean tree を scan した予測値 10 件と一致）。

## 5. ビルドキャッシュ（項目 11）

`cache-from: type=gha` / `cache-to: type=gha,mode=max`（scope はイメージごとに分離）が
実際に往復していることはログで確認できた。

```text
#6 importing cache manifest from gha:12742113790445036199
#9 exporting to GitHub Actions Cache
#9 sending cache export 0.3s done
```

Trivy のバイナリ自体も trivy-action のキャッシュに乗っている（`Cache hit for: trivy-binary-v0.70.0-Linux-X64`）。

**所要時間の短縮は測定できていない。** 本リポジトリのフィクスチャは `FROM` + `CMD` + `USER` の
3 行しかなく、キャッシュで飛ばせる高コストなレイヤーが存在しないためである
（Build image step は 1 回目 5 秒 / 2 回目 6 秒で、差は実行ごとのばらつきの範囲）。
実アプリのイメージでのキャッシュ効果は **未実測**であり、消費側（ticket-c2c-platform）の
caller 導入時に測る。

## 6. 所要時間

| 対象 | 実測 |
| --- | --- |
| `Trivy Config Scan`（本リポジトリ全体） | 11 秒（job 全体） |
| `Trivy Image Scan`（フィクスチャ、SARIF なし） | 30 秒 / 35 秒（job 全体）。うち build 4〜5 秒、scan(json) 12〜13 秒 |
| `Trivy Image Scan`（フィクスチャ、SARIF あり） | 1 分 3 秒 / 1 分 28 秒（job 全体） |

`upload-sarif: true` にすると 30 秒前後増える。config が数十秒、image が分単位という
コスト差は、2 本の reusable workflow に分けた根拠（ADR-0008 追記 2026-08-11）と整合している。

## 検証で汚した範囲と後始末

- 使い捨て Draft PR #183 / #184 / #185 はクローズし、ブランチを削除した。マージしていない
- code scanning alert は `refs/pull/183/merge` / `refs/pull/184/merge` に紐づく。
  default branch（`main`）の alert は増やしていない。PR クローズ後は Security タブの既定表示に現れない
- `trivy-image-selftest.yml` は `pull_request` では **SARIF を上げない**設定にしてあり、
  今後の通常運用で Security タブがフィクスチャの finding で汚れることはない
- AWS リソースには一切触れていない
