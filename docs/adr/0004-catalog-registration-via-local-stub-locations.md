# 0004. 既存リポジトリのカタログ登録は当面 idp-golden-path 内の file location スタブで行う

## ステータス

Accepted

## 日付

2026-07-07

## 決定内容

[terraform-hannibal](https://github.com/kmryst/terraform-hannibal) / [ticket-c2c-platform](https://github.com/kmryst/ticket-c2c-platform) の Software Catalog 登録は、当面 `idp-golden-path` リポジトリ内の `catalog/portfolio.yaml`（file location スタブ）で行う。

各リポジトリのルートに `catalog-info.yaml` を置き url location で取り込む「本来の形」への移行は、他リポジトリへの変更としてユーザー確認を得たうえで別 Issue で実施し、その時点でスタブを url location に置き換える。

組織エンティティ（User `kmryst` / Group `platform`）も同様に `catalog/org.yaml` で管理する。

## 背景

Backstage の標準的なカタログ運用は「各リポジトリが自身の `catalog-info.yaml` を所有し、Backstage が url location（または GitHub discovery）で取り込む」形である。所有権がリポジトリ側にあり、メタデータがコードと同じレビューを通る。

一方、本プロジェクトでは他リポジトリ（terraform-hannibal / ticket-c2c-platform）への変更はユーザー確認を挟む運用としており、Catalog を実データで動かす作業をそれ待ちにするとポートフォリオの進行が止まる。

## 検討した選択肢

### idp-golden-path 内の file location スタブ（採択）

- 長所: 他リポジトリを変更せずに Catalog を実データで動作させられる
- 長所: GITHUB_TOKEN なしでもローカル起動だけで Catalog が埋まる（url location は token 設定が必要）
- 短所: エンティティ定義の所有権が対象リポジトリ側にない。対象リポジトリの実態と定義が乖離し得る

### 各リポジトリに catalog-info.yaml + url location（本来の形、移行先）

- 長所: Backstage 標準の所有モデル。リポジトリの変更とメタデータ更新が同じ PR で流れる
- 短所: 他リポジトリへの変更が必要（ユーザー確認待ち）
- 短所: url location の取り込みに GitHub integration（token）設定が必要

### GitHub org discovery

- 長所: リポジトリ追加時に自動でカタログへ反映される
- 短所: 個人アカウント配下のリポジトリ全走査は過剰。まず静的登録で十分

## 採択理由

- 他リポジトリ変更のユーザー確認を待たずに、Catalog の実データ登録・TechDocs・CI と作業を進められる
- スタブから url location への置き換えは locations 設定の差し替えだけで済み、移行コストが低い

## 影響

- `catalog/portfolio.yaml` が当面のエンティティ定義の正本となる。対象リポジトリの大きな変化（アーカイブ・リネーム等）があれば手動で追従する
- フォローアップ（別 Issue、ユーザー確認が必要）: terraform-hannibal / ticket-c2c-platform への `catalog-info.yaml` 追加と、本リポジトリ側の url location への置き換え

## 関連

- [ADR 0003](./0003-backstage-app-layout-and-local-dev-baseline.md) — Backstage アプリのローカル開発基準
- Issue [#16](https://github.com/kmryst/idp-golden-path/issues/16)
