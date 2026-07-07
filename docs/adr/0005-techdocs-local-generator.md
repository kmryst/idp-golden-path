# 0005. TechDocs はローカル builder + ホスト mkdocs（runIn local）で運用する

## ステータス

Accepted

## 日付

2026-07-07

## 決定内容

TechDocs の構成を次の通りとする（すべてローカル開発フェーズの基準構成）。

- `techdocs.builder: local` — エンティティ閲覧時に Backstage backend がオンデマンドでビルドする
- `techdocs.generator.runIn: local` — ホストにインストールした mkdocs（`mkdocs-techdocs-core` 入り）を使う
- `techdocs.publisher.type: local` — 生成物は backend のローカルディスクに保存する

ホストへの mkdocs 導入は `uv tool install mkdocs --with mkdocs-techdocs-core` を標準手順とする。

デプロイ時（CI ビルド + S3 等の external publisher への移行）は別 ADR で判断する。

## 背景

TechDocs の generator はデフォルトで `runIn: docker`（`spotify/techdocs` イメージ内で mkdocs を実行）になっている。docker 方式はホストに Python 環境を要求しない一方、イメージの pull（数百 MB 超）と WSL2 上の docker 経由のファイルマウントが必要で、ローカルの反復開発にはオーバーヘッドが大きい。

## 検討した選択肢

### runIn: local + uv tool でホストに mkdocs 導入（採択）

- 長所: ビルドが軽く速い。docker デーモン非依存
- 長所: `uv tool` により PEP 668（externally-managed-environment）を回避しつつ、隔離された venv に導入できる
- 短所: 開発者ごとにホストへの mkdocs 導入が必要（手順は app-config のコメントと ADR に明記）

### runIn: docker（デフォルト）

- 長所: ホスト環境を汚さない。バージョンがイメージで固定される
- 短所: 初回イメージ pull が重い。WSL2 でのマウント・実行オーバーヘッド

### builder: external（CI ビルド + S3 等）

- 長所: 本番運用の推奨構成。backend の負荷がない
- 短所: AWS リソース（S3）とデプロイパイプラインが前提で、現段階（ローカルのみ・課金なし）に合わない。デプロイ着手時に移行を判断する

## 採択理由

- ローカル動作確認フェーズでは、ビルドの軽さと反復速度を優先する
- `uv tool` の隔離インストールにより、システム Python を壊さずに導入できる

## 影響

- 開発環境セットアップに mkdocs 導入手順が加わる（README に記載）
- 本番デプロイ時には builder: external + CI ビルドへの移行を別 ADR で判断する（TechDocs の推奨構成）
- TechDocs 対象は当面 idp-golden-path 自身のみ。他リポジトリの TechDocs 化は catalog-info.yaml と同様に各リポジトリへの変更が必要（ADR-0004 のフォローアップと同時に判断）
- `idp-golden-path` 自身の `catalog-info.yaml` は `backstage/` 配下ではなくリポジトリルートに配置する。TechDocs の `dir:` 参照は取り込み元ファイルの祖先ディレクトリを越えられない制約（path traversal 防止）があり、`backstage/catalog-info.yaml` から `techdocs-ref: dir:..` でリポジトリルートの `mkdocs.yml` を参照しようとするとビルドが失敗する（`Relative path is not allowed to refer to a directory outside its parent`）。catalog-info.yaml と mkdocs.yml を同じディレクトリ（リポジトリルート）に置くことで解消した

## 関連

- [ADR 0003](./0003-backstage-app-layout-and-local-dev-baseline.md) — ローカル開発の基準構成
- [ADR 0004](./0004-catalog-registration-via-local-stub-locations.md) — カタログ登録スタブ
- Issue [#22](https://github.com/kmryst/idp-golden-path/issues/22)
