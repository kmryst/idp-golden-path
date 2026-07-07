# 0007. Scaffolder の GitHub 連携は個人 PAT を継続し、GitHub App へは移行しない

## ステータス

Accepted

## 日付

2026-07-07

## 決定内容

Scaffolder の `publish:github` アクションの認証方式は、ADR-0006 で採択した個人 PAT（`GITHUB_TOKEN` 環境変数、`integrations.github[].token`）を継続する。GitHub App への移行は行わない。

判断の根拠は空論ではなく実機検証で確定させた。実際に GitHub App（`idp-golden-path-scaffolder`、App ID 4237280）を作成し、kmryst アカウント（個人アカウント、All repositories）にインストールした上で、installation token を用いて `POST /user/repos`（個人アカウント配下のリポジトリ作成 API。`publish:github` が owner を個人アカウントと判定した場合に呼ぶエンドポイント）を実行したところ、次の結果になった。

```text
INSTALLATION id=144968308 account=kmryst target_type=User repository_selection=all
PERMISSIONS {"administration":"write","contents":"write","metadata":"read","workflows":"write"}
INSTALLATION_TOKEN acquired
CREATE_USER_REPO status=403 message=Resource not accessible by integration
```

`administration` / `contents` / `workflows` をすべて `write` で許可し、`All repositories` でインストールしても、installation token では個人アカウント配下の新規リポジトリ作成そのものが GitHub API レベルで拒否される。これは権限設定やスコープの取り違えではなく、GitHub App の installation token の仕様上の制約であり、Backstage 側の実装や設定を変えても回避できない。

## 背景

ADR-0006 で PAT 方式を採択した際、GitHub App 移行は「名義がアプリになり、fine-grained な権限と組織単位のインストール管理ができる」利点を認めつつ、「App 登録・秘密鍵管理・Org が前提となり、個人ポートフォリオのローカル開発フェーズには過剰」として見送り、「必要になった段階で別 ADR / Issue として扱う」としていた。

今回、ユーザーから GitHub App 移行への着手依頼があり（Issue #30）、移行を前提に設計を進めた上で、実機検証によって最終判断を確定させることにした。

## 検討した選択肢

### PAT 継続（採択）

- 長所: 追加実装が不要で、`publish:github` の個人アカウント配下でのリポジトリ作成が問題なく動作する（既存動作の実績、ADR-0006）
- 長所: ローカル開発基準（ADR-0003、guest 認証 + インメモリ SQLite）と整合し、`gh auth token` を転用できる
- 短所: トークンが個人アカウントに紐づき、実行者の権限で publish される（監査上プラットフォーム名義にならない）。ただし本リポジトリは個人ポートフォリオであり、この短所が問題化する運用主体（複数開発者・Org）が存在しない

### GitHub App 完全移行（見送り、実機検証により技術的に不成立と判明）

- 長所（設計時点の期待）: 名義がアプリになり、fine-grained permission・installation 単位の管理・短命トークンが得られる
- 短所（実機検証で確定）: **installation token は `POST /user/repos`（個人アカウント配下のリポジトリ作成）に対して `403 Resource not accessible by integration` を返す。** Backstage 公式ドキュメントにも「GitHub App 連携は個人リポジトリではなく組織リポジトリの認証用に構築されている」と明記されており、今回の実機結果と一致する
- 結論: 個人アカウント（Org を使わない本ポートフォリオの前提、CLAUDE.md）である限り、GitHub App だけで `publish:github` を完結させることはできない。Org 化しない限り「完全移行」は選択肢として技術的に成立しない

### ハイブリッド（GitHub App を他の認証用途に限定利用、見送り）

- 内容: `publish:github` は PAT のまま残し、GitHub App は `auth.providers.github`（ユーザーログイン用の GitHub OAuth）や、将来の Org 化後の repo 作成に限定して使う案
- 長所: App の投資（作成・installation・秘密鍵管理）を無駄にしない
- 短所: 本リポジトリはローカル開発基準として guest 認証を採用しており（ADR-0003）、GitHub ログインを追加する具体的な需要が現時点でない。「App を作ったから使い道を探す」動機での追加は、未確定の要件を先取りして構成を複雑化させるだけであり、ADR-0006 が避けた「未確定の技術選定を持ち込む」ことと同じ問題を再現する
- 結論: 需要が具体化した時点で改めて ADR 化する。現時点では見送る

## 採択理由

- 個人アカウント運用という本ポートフォリオの前提（CLAUDE.md: 「Org ではなく個人アカウント（kmryst）配下で運用」）のもとでは、GitHub App の installation token は `publish:github` が呼ぶ個人アカウント向けリポジトリ作成 API を利用できないことが実機検証で確定した。これは設定や権限の調整では解決できない、GitHub API 仕様上の制約である
- GitHub App は本来チーム/Org 運用で威力を発揮する仕組みであり、個人ポートフォリオでの正当化根拠（監査上の名義分離、fine-grained 権限）は、今回の検証で「そもそも動かない」という技術的制約の前では意味をなさない
- PAT 方式は ADR-0006 の採択理由（ローカル開発基準との整合、秘匿情報の環境変数注入）を引き続き満たしており、動作実績もある

## 影響

- `backstage/app-config.yaml` の `integrations.github` / `auth.providers` は変更しない
- 作成した GitHub App（`idp-golden-path-scaffolder`）は本 ADR の結論により `publish:github` の用途では使用しない。将来 Org 化や GitHub ログイン導入等の具体的な要件が生じた時点で、再利用するか削除するかを別途判断する
- `docs/operations/scaffolder-github-integration.md` に本検証結果への参照を追記し、GitHub App が個人アカウント向けリポジトリ作成に使えないことを明記する
- ADR-0006 の「影響」節に記載された「GitHub App 移行は必要になった段階で別 ADR」という見送りは、本 ADR により「個人アカウント運用を続ける限り移行しない」という判断に更新される

## 関連

- [ADR 0006](./0006-scaffolder-service-baseline-template.md) — Scaffolder ゴールデンパステンプレートと PAT 方式の採択
- [ADR 0003](./0003-backstage-app-layout-and-local-dev-baseline.md) — ローカル開発基準（guest 認証 + インメモリ SQLite）
- Issue [#30](https://github.com/kmryst/idp-golden-path/issues/30)
- [docs/operations/scaffolder-github-integration.md](../operations/scaffolder-github-integration.md)
