# 0011. 既存リポジトリのカタログ登録は各リポジトリ所有の catalog-info.yaml + GitHub URL location へ移行する

## ステータス

Accepted

## 日付

2026-07-10

## 決定内容

[terraform-hannibal](https://github.com/kmryst/terraform-hannibal) / [ticket-c2c-platform](https://github.com/kmryst/ticket-c2c-platform) の Software Catalog 登録を、`idp-golden-path` 内の `catalog/portfolio.yaml`（file location スタブ）から、各リポジトリ自身が所有する `catalog-info.yaml` を GitHub URL location で取り込む形へ移行する。

- `terraform-hannibal` / `ticket-c2c-platform` のリポジトリルートに `catalog-info.yaml`（Component 定義）を追加する（[terraform-hannibal #489](https://github.com/kmryst/terraform-hannibal/issues/489) / [ticket-c2c-platform #229](https://github.com/kmryst/ticket-c2c-platform/issues/229)）
- `backstage/app-config.yaml` / `backstage/app-config.production.yaml` の `catalog.locations` を、対象 2 リポジトリ分について `type: url` の GitHub location に切り替える
- `catalog/portfolio.yaml` から Component 定義（terraform-hannibal / ticket-c2c-platform 分）を削除し、System 定義（`kmryst-portfolio`）のみを残す
- Catalog metadata の source of truth は、対象リポジトリについては各リポジトリの `catalog-info.yaml`、ポートフォリオ全体を横断する System 定義については `idp-golden-path/catalog/portfolio.yaml` とする

本 ADR は [ADR 0004](./0004-catalog-registration-via-local-stub-locations.md) を supersede する。

## 背景

ADR 0004 の時点では、他リポジトリへの変更にはユーザー確認を要する運用のため、Catalog を実データで動かす作業をその確認待ちにするとポートフォリオ全体の進行が止まる懸念があった。そのため当面の代替として idp-golden-path 内の file location スタブで Component を代筆していた。

その後、terraform-hannibal / ticket-c2c-platform への変更について改めてユーザー確認を得られたため（[idp-golden-path #91](https://github.com/kmryst/idp-golden-path/issues/91)）、ADR 0004 で「本来の形」として整理していた移行を実施する。

## 検討した選択肢

### 各リポジトリに catalog-info.yaml + GitHub URL location（採択）

- 長所: Backstage 標準の所有モデル。リポジトリの変更とメタデータ更新が同じ PR で流れる
- 長所: ローカル起動・AWS 上起動のどちらも同じ GitHub URL location を参照するため、Catalog 入力元が環境間で分岐しない
- 短所: GitHub integration（token）設定がローカル・本番の両方で必要になる（既に GitHub OAuth を利用しており、追加の認証情報管理は増えない）

### idp-golden-path 内の file location スタブを維持（現状、不採択）

- 長所: 追加の GitHub token 設定が不要
- 短所: エンティティ定義の所有権が対象リポジトリ側になく、実態と定義が乖離し得る（ADR 0004 で指摘済みの課題が解消されない）

### ローカル file location で `../terraform-hannibal/catalog-info.yaml` のように相対パス参照する案（不採択）

- 短所: 個人マシンのディレクトリ構成（リポジトリの clone 位置）に依存し、他の環境（AWS 上の Backstage、他マシン）で同じ設定が使えない

## 採択理由

- 対象リポジトリへの変更についてユーザー確認が得られ、ADR 0004 で「フォローアップ」として明記していた移行条件が満たされた
- ローカル起動と AWS 上起動で同じ Catalog 入力元（GitHub URL location）を参照できるようになり、環境差分が解消される
- Catalog metadata の変更が対象リポジトリの通常の PR レビューを通るようになり、実態との乖離を防ぎやすくなる

## 影響

- `catalog/portfolio.yaml` は Component 定義の正本ではなくなる。System 定義（`kmryst-portfolio`）の置き場としてのみ残る
- `backstage/app-config.yaml` / `backstage/app-config.production.yaml` に GitHub integration（token）設定が前提として必要になる
- 今後、ポートフォリオに新しいリポジトリを追加する場合は、そのリポジトリ自身に `catalog-info.yaml` を追加し、`catalog.locations` に GitHub URL location を 1 件追加する運用とする

## 関連

- [ADR 0004](./0004-catalog-registration-via-local-stub-locations.md) — 本 ADR が supersede する旧 ADR
- [ADR 0003](./0003-backstage-app-layout-and-local-dev-baseline.md) — Backstage アプリのローカル開発基準
- Issue [#91](https://github.com/kmryst/idp-golden-path/issues/91) / [#92](https://github.com/kmryst/idp-golden-path/issues/92)
