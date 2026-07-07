# 0001. idp-golden-path の service-baseline テンプレートからリポジトリを生成する

## ステータス

Accepted

## 日付

このリポジトリの初回コミット日（Scaffolder によるテンプレート生成日）

## 決定内容

`${{ values.name }}` のリポジトリを、[idp-golden-path](https://github.com/kmryst/idp-golden-path) の
Backstage Scaffolder テンプレート **service-baseline** から生成する。

生成時に適用された運用基盤:

- 軽運用 / 厳密運用を分ける GitHub Flow（`CONTRIBUTING.md`）
- 必須 4 ラベル（type / area / risk / cost）と `.github/labels.yml` による定義のコード管理
- CI ガードレール: PR Policy Check / Commitlint / Markdown Lint / Gitleaks Secret Scan / Sync Labels
- Issue / PR helper（`scripts/github/`）と PR / Issue テンプレート
- ADR 運用（`docs/adr/README.md`）
- Backstage Software Catalog / TechDocs 対応（`catalog-info.yaml` / `mkdocs.yml`）

## 背景

サービス立ち上げのたびに運用ガードレールを手作業で再整備すると、リポジトリごとの品質のばらつきと立ち上げコストが発生する。
idp-golden-path はこの再発明を防ぐため、確立済みの運用基盤をゴールデンパステンプレートとして提供している。

## 検討した選択肢

### service-baseline テンプレートから生成する（採択）

- 長所: 運用基盤（CI・ラベル・テンプレート・ADR 運用）が最初から揃う
- 短所: アプリケーションコードは含まれないため、技術選定と実装は別途行う

### 空リポジトリから手作業で立ち上げる（見送り）

- 長所: 制約なく自由に構成できる
- 短所: 既存リポジトリで確立済みの運用の再発明になり、抜け漏れが生じやすい

## 採択理由

確立済みの運用モデルを再発明せずに引き継ぎ、立ち上げ直後から Issue / PR 駆動 + CI ガードレールで開発を始められるため。

## 影響

- アプリケーションコードの技術選定（言語・フレームワーク・インフラ）は、実装着手時に新しい ADR として記録する
- branch protection は未適用の状態で生成される。初回 CI 実行後に `docs/operations/branch-protection.md` の手順で適用する
- 生成元テンプレートが更新されても、生成済みリポジトリへは自動反映されない。必要な場合は手動で追随する

## 関連

- 生成元テンプレート: [idp-golden-path — backstage/templates/service-baseline](https://github.com/kmryst/idp-golden-path/tree/main/backstage/templates/service-baseline)
- 設計判断: [idp-golden-path ADR-0006](https://github.com/kmryst/idp-golden-path/blob/main/docs/adr/0006-scaffolder-service-baseline-template.md)
