# Scaffolder GitHub 連携（ローカル開発）

ゴールデンパステンプレート（[ADR-0006](../adr/0006-scaffolder-service-baseline-template.md)）の
`publish:github` ステップをローカルで実行するための前提条件と手順です。

## 前提条件

### GitHub Personal Access Token（PAT）

`backstage/app-config.yaml` の `integrations.github` は `GITHUB_TOKEN` 環境変数を参照します。
トークンはファイルに書かず、必ず環境変数で注入します（`.env` のコミットは禁止事項）。

| 用途 | 必要スコープ（classic PAT） |
| --- | --- |
| リポジトリ作成・push（`publish:github`） | `repo`（public のみなら `public_repo`） |
| workflow ファイルを含む push | `workflow`（skeleton は `.github/workflows/` を含むため**必須**） |
| 検証後のリポジトリ削除（destroy） | `delete_repo`（`gh repo delete` を使う場合） |

`gh` CLI でログイン済みであれば、発行済みトークンを転用できます。

```bash
# gh の発行済みトークンを確認（repo / workflow スコープがあること）
gh auth status

# Backstage を起動するシェルで注入する
export GITHUB_TOKEN="$(gh auth token)"
```

> `delete_repo` は `gh` の標準ログインには含まれません。検証用リポジトリを CLI で削除する場合は
> `gh auth refresh -h github.com -s delete_repo` で追加してください（Web UI から削除する場合は不要）。

### Org 設定

個人アカウント（`kmryst`）配下に作成する場合、Org 設定は不要です。
RepoUrlPicker の Owner に自分のユーザー名を入力します。Org 配下に作成する場合は、
PAT がその Org に対して SSO 認可されている必要があります。

## 実行手順

```bash
cd backstage
export GITHUB_TOKEN="$(gh auth token)"
yarn start   # frontend: http://localhost:3000 / backend: http://localhost:7007
```

1. `http://localhost:3000/create` を開く（guest 認証、ADR-0003）
2. **Service Baseline (Golden Path)** を選択する
3. サービス情報（name / description / owner / lifecycle）を入力する
4. 公開先（Owner = GitHub ユーザー名、Repository = リポジトリ名、可視性）を入力して実行する
5. 完了後、output のリンクから生成リポジトリと Catalog エンティティを確認する

## 検証後の片付け（destroy）

ドライランで作成したリポジトリは残さず削除します。

```bash
gh repo delete <owner>/<repo> --yes   # delete_repo スコープが必要
```

Catalog に登録したエンティティは、Backstage UI のエンティティページ → Unregister entity で解除します
（ローカルはインメモリ SQLite のため、backend 再起動でも消えます）。

## 制約・注意

- `GITHUB_TOKEN` 未設定でも Backstage は起動するが、`publish:github` ステップが認証エラーで失敗する
- private リポジトリを選んだ場合、GitHub のプランによっては branch protection が適用できない
- テンプレートは branch protection を自動適用しない。生成物の `docs/operations/branch-protection.md` の手順で
  初回 CI 実行後に適用する（ADR-0006）

## GitHub App は使わない（ADR-0007）

PAT ではなく GitHub App で認証する移行を検討し、実際に GitHub App を作成して installation token での動作を実機検証したが、
個人アカウント（kmryst）配下では installation token による `POST /user/repos`（新規リポジトリ作成）が
`403 Resource not accessible by integration` で拒否されることを確認した。これは GitHub API の仕様上の制約であり、
権限設定では回避できない。個人アカウント運用を続ける限り GitHub App 移行は行わない。詳細は
[ADR-0007](../adr/0007-scaffolder-github-app-authentication.md) を参照。
