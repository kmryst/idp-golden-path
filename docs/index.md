# idp-golden-path

Backstage をベースにした Internal Developer Platform (IDP) のポートフォリオ実装です。
サービス新規立ち上げ時の「ゴールデンパス」（テンプレート・CI/CD・インフラ・ガードレールの一括提供）のセルフサービス化を目指しています。

## このドキュメントについて

このサイトは Backstage の TechDocs（docs-like-code）でビルドされています。
正本は GitHub リポジトリの `docs/` 配下の Markdown で、変更は Issue / PR 駆動の開発フロー（[CONTRIBUTING.md](https://github.com/kmryst/idp-golden-path/blob/main/CONTRIBUTING.md)）に従います。

## 主なコンテンツ

- [ADR 一覧](./adr/README.md) — Backstage 採用、GitHub Flow 踏襲などの設計判断の記録
- [branch protection](./operations/branch-protection.md) — main ブランチ保護設定の正本

## 関連リポジトリ

| リポジトリ | 概要 |
| --- | --- |
| [terraform-hannibal](https://github.com/kmryst/terraform-hannibal) | Terraform / AWS / GitHub Actions の IaC ポートフォリオ |
| [ticket-c2c-platform](https://github.com/kmryst/ticket-c2c-platform) | C2C チケット売買プラットフォームの設計・実装 |
