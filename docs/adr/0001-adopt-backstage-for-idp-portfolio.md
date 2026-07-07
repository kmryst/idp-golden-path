# 0001. IDP ポートフォリオの基盤に Backstage を採用する

## ステータス

Accepted

## 日付

2026-07-07

## 決定内容

`idp-golden-path` の Internal Developer Platform (IDP) 実装の基盤として、CNCF Incubating プロジェクトである [Backstage](https://backstage.io/) を採用する。

Software Catalog / Scaffolder（Software Templates）/ TechDocs を中核機能として使い、サービス新規立ち上げ時の「ゴールデンパス」（テンプレート・CI/CD・インフラ・ガードレールの一括提供）をセルフサービス化する。

デプロイ先インフラ（AWS 構成、Terraform 設計）は実装着手時に別 ADR で確定する。

## 背景

[terraform-hannibal](https://github.com/kmryst/terraform-hannibal) / [ticket-c2c-platform](https://github.com/kmryst/ticket-c2c-platform) の 2 リポジトリでは、次をすべて手作業で整備してきた。

- ADR ドリブンな意思決定の記録
- production-readiness 相当のチェック（ラベル・PR Policy・ロールバック欄）
- CI ガードレール（commitlint / policy check / secret scan など）

リポジトリが増えるたびに同じ基盤を再発明しており、この「運用基盤の複製」自体がプラットフォームとして抽象化すべき課題である。Platform Engineering のポートフォリオとして、この課題を IDP（ゴールデンパスのセルフサービス化）で解決する形を示したい。

## 検討した選択肢

### Backstage（採択）

- 長所: Software Catalog / Scaffolder / TechDocs が同梱され、ゴールデンパスの構成要素（テンプレート化・カタログ登録・ドキュメント統合）を単一基盤で示せる
- 長所: CNCF Incubating・Spotify 発のデファクトであり、Platform Engineering の実務文脈（求人・事例）との接続が強い
- 長所: Node.js / TypeScript ベースでプラグイン拡張でき、既存 2 リポジトリの技術スタック（Node.js）と地続き
- 短所: モノリシックなフレームワークで学習コスト・運用コスト（ビルド・アップグレード追従）が高い

### Port / OpsLevel / Cortex などの SaaS 型 Internal Developer Portal

- 長所: セットアップが速く、カタログ・スコアカード機能が最初から揃う
- 短所: 実装の中身がブラックボックスになり、ポートフォリオとして「作った」ことを示しにくい
- 短所: 無料枠・契約条件に依存し、公開ポートフォリオとして再現性が低い

### 自作ポータル（軽量 Web アプリ + GitHub API）

- 長所: 完全に自由で軽量。必要な機能だけ実装できる
- 短所: カタログ・テンプレート・ドキュメント統合を一から作ることになり、IDP の本質（ゴールデンパス設計）より周辺実装に工数が偏る
- 短所: 業界標準ツールの運用経験としてアピールしづらい

### ADR / ガードレールの共通化のみ（テンプレートリポジトリや再利用 workflow で対応）

- 長所: 最小工数で既存 2 リポジトリの再発明問題は緩和できる
- 短所: 「プラットフォームとして抽象化する」というポートフォリオの主題に届かず、セルフサービス化・カタログ化を示せない

## 採択理由

ポートフォリオの主題は「運用基盤の再発明をプラットフォームとして抽象化する」ことであり、カタログ・テンプレート・ドキュメントを単一基盤で統合できる Backstage が最も主題に合致する。

業界のデファクトであるため、Platform Engineering の実務スキルとしての証明力が高い。学習・運用コストは高いが、それ自体が「プラットフォームを運用する」経験としてポートフォリオの価値になる。

SaaS 型は実装を示せず、自作は周辺実装に工数が偏るため、いずれも主題への適合で Backstage に劣る。

## 影響

- アプリケーションは Node.js / TypeScript（Backstage app + backend）で実装する
- ゴールデンパスは Scaffolder の Software Templates として表現し、生成物に CI・ガードレール・ADR 雛形を含める
- 既存 2 リポジトリは Software Catalog 登録の題材（実在サービス）として活用できる
- Backstage のアップグレード追従・ビルド時間・認証permission設計が今後の運用課題になる（必要に応じて ADR 化する）

## 関連

- [Issue #10](https://github.com/kmryst/idp-golden-path/issues/10)
- [ADR 0002](./0002-adopt-lightweight-and-strict-github-flow.md) - 運用基盤の踏襲
- [README.md](../../README.md)
