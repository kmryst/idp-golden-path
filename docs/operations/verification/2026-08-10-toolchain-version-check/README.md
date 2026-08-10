# Toolchain Version Check ネガティブテスト 検証記録 (2026-08-10)

## 経緯

`toolchain-version-check.yml`（[ADR-0014](../../../adr/0014-terraform-toolchain-version-standardization.md) / Issue #174 / PR #175、commit `4da66ab`）は、
`.mise.toml` の Terraform 宣言と workflow に直書きされた CI pin の一致を PR ごとに検査する reusable workflow である。

導入 PR で確認できたのは **一致しているときに緑になること**（ポジティブ経路）だけだった。
検査ジョブは「落ちるべきときに落ちる」ことが確認できて初めて意味を持つ。
一致検査は誤って常に pass する実装（対象ファイルを 1 件も拾えていない、パースに失敗して空集合を返している等）でも
導入 PR では緑になってしまい、ポジティブ経路の緑だけでは機能している証拠にならない。

そこで 3 リポジトリそれぞれに **意図的な drift を仕込んだ使い捨ての Draft PR** を立て、
実際に GitHub Actions 上で落ちること・落ち方が正しいことを実測した。

検証用 PR は idp-golden-path #178 / terraform-hannibal #596 / ticket-c2c-platform #462 で、
いずれも `main` にマージせず、検証後にクローズしてブランチを削除した。本番の workflow・`.mise.toml` は一切変更していない。

## 何を仕込んだか

drift は **両方向**で仕込んだ。`.mise.toml` 側を動かす場合と workflow の pin 側を動かす場合で、
検査が拾う対象と出るメッセージが変わるためである。

| 方向 | 仕込み | 期待する挙動 |
| --- | --- | --- |
| `.mise.toml` 側 | `.mise.toml` の terraform を 1.12.1 に変更（workflow の pin は 1.14.8 のまま据え置き） | そのリポジトリの **全 pin** が不一致として列挙される |
| workflow 側 | workflow 1 ファイルの pin だけを 1.12.1 に変更（`.mise.toml` は 1.14.8 のまま） | その **1 件だけ**が検出され、正しい他の pin は検出されない（誤検知なし） |

## 確認結果

### 1. idp-golden-path（配布元。dual-trigger のため caller を経由しない）

| run | 仕込んだ drift | 検出結果 |
| --- | --- | --- |
| [31392839564](https://github.com/kmryst/idp-golden-path/actions/runs/31392839564) | なし（PR #175 本体） | success |
| [31398927320](https://github.com/kmryst/idp-golden-path/actions/runs/31398927320) | `.mise.toml` を 1.12.1 に | `destroy.yml` L24 / `deploy.yml` L20 の **2 pin をすべて列挙** |
| [31399408516](https://github.com/kmryst/idp-golden-path/actions/runs/31399408516) | `destroy.yml` の pin のみ 1.12.1 に | `destroy.yml` L24 の **1 件のみ**（`deploy.yml` は誤検知せず） |

出力されたエラーメッセージの実例（run 31399408516）:

```text
`.github/workflows/destroy.yml` L24 の `TERRAFORM_VERSION` は `1.12.1` ですが、`.mise.toml` は `1.14.8` を宣言しています。両者を一致させてください（ADR-0014）
```

「どのファイルの何行目が何になっていて、`.mise.toml` は何を宣言しているか」を出すという ADR-0014 の検査の契約どおりの内容になっている。

### 2. terraform-hannibal（caller 経由）

| run | 仕込んだ drift | 検出結果 |
| --- | --- | --- |
| [31394737536](https://github.com/kmryst/terraform-hannibal/actions/runs/31394737536) | なし（PR #592 本体） | success |
| [31398931474](https://github.com/kmryst/terraform-hannibal/actions/runs/31398931474) | `.mise.toml` を 1.12.1 に | `pr-check.yml` L16 / `destroy.yml` L5 / `deploy.yml` L5 の **3 pin をすべて列挙** |
| [31399415310](https://github.com/kmryst/terraform-hannibal/actions/runs/31399415310) | `destroy.yml` の pin のみ 1.12.1 に | `destroy.yml` L5 の **1 件のみ** |

**間接参照を pin と誤認しないことも実測できている。** terraform-hannibal の `pr-check.yml` には
`terraform_version: ${{ env.TERRAFORM_VERSION }}` という env 参照行（L247）があるが、
drift なしの run 31394737536 は success であり、`.mise.toml` 側 drift の run 31398931474 でも
この行は列挙されていない（列挙されたのはリテラル値を持つ 3 件のみ）。
「参照は実体ではないので pin とみなさない」という ADR-0014 の契約が実 CI 上で成立している。

### 3. ticket-c2c-platform（caller 経由）

| run | 仕込んだ drift | 検出結果 |
| --- | --- | --- |
| [31394846271](https://github.com/kmryst/ticket-c2c-platform/actions/runs/31394846271) | なし（導入 PR 本体） | success |
| [31398931465](https://github.com/kmryst/ticket-c2c-platform/actions/runs/31398931465) | `.mise.toml` を 1.12.1 に | `terraform-plan.yml` L32 / `terraform-destroy-staging.yml` L37 / `terraform-destroy-dev.yml` L36 / `terraform-apply-staging.yml` L44 / `terraform-apply-dev.yml` L27 / `terraform-apply-bootstrap.yml` L29 / `staging-smoke-test.yml` L27 / `pr-check.yml` L181 / `dev-smoke-test.yml` L30 の **9 pin をすべて列挙** |
| [31399420049](https://github.com/kmryst/ticket-c2c-platform/actions/runs/31399420049) | `terraform-destroy-dev.yml` の pin のみ 1.12.1 に | `terraform-destroy-dev.yml` L36 の **1 件のみ** |

9 件という数は、検証前に同リポジトリを grep して数えた `terraform_version` 直書きの実在数と**完全に一致**する。
検出漏れ（拾えていないファイルがある）が無いことの根拠はこの一致である。

### 4. まとめ

- 3 リポジトリすべてで、両方向の drift を検出することを確認した
- 検出漏れゼロ（実在する pin の数と列挙数が一致）
- 誤検知ゼロ（正しい pin・env 参照行を不一致として挙げない）
- caller 経由（terraform-hannibal / ticket-c2c-platform）でも配布元自身と同じ判定・同じメッセージが出る

## 未検証のまま残っている範囲

次の 2 経路は**ローカルのフィクスチャ検証のみで、実 CI 上では踏んでいない**。

- `.mise.toml` が存在しない場合の fail（ADR-0014 で「skip せず fail」と決めた経路）
- `.mise.toml` の TOML 解析に失敗した場合の fail

実 CI で踏むには `.mise.toml` を消す / 壊す Draft PR が追加で必要になるが、
これらは検査対象ファイルの探索・比較ロジックを通らない早期 exit の分岐であり、
上記の実測で確認できた本体ロジックとは独立している。実 CI での確認は、
`.mise.toml` を移動・改名する変更が実際に発生したときに合わせて行う。

## ログ取得上の注意

caller 経由の run では `gh run view <run-id> --log` がログ本文を返さない。
検出内容は ANNOTATIONS から読む。手順は
[CI 品質ゲート トラブルシューティング](../../ci-quality-gates-troubleshooting.md) を参照。

## 関連

- [ADR 0014. Terraform ツールチェーンのバージョンを 3 リポジトリで 1.14.8 に統一し、ローカル正本と CI pin の整合性を CI で検査する](../../../adr/0014-terraform-toolchain-version-standardization.md)
- [ADR 0008. CI ガードレールを reusable workflows として提供し、タグ固定（`@v1`）で参照する](../../../adr/0008-ci-guardrails-as-reusable-workflows-with-tag-pinning.md)
- [main ブランチ保護設定](../../branch-protection.md) — check run 名
- Issue #174 / PR #175 — 本 workflow の新設
- Issue #179 — 本検証記録の追加
