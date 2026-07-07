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

## PAT のローテーション / 失効（revoke）

credential のライフサイクル（発行 → 利用 → ローテーション → 失効）の後半 2 つの手順です。
手順内に secret 値そのものは書かず、必ずプレースホルダ（`<新しいPAT>` 等）で表記します。
fine-grained PAT への移行など PAT 運用自体の変更は本節のスコープ外です（別途 ADR で判断する）。

### 平時のローテーション方針

- **有効期限**: 専用の classic PAT を発行する場合は無期限（No expiration）にせず、**90 日以内**の有効期限を設定する
- **周期**: 有効期限にあわせて期限切れ前に再発行する。GitHub からの期限切れ予告メール（期限の約 1 週間前）をトリガーにしてよい
- **`gh auth token` を転用している場合**: トークンは `gh` CLI のログインセッションに紐づく。`gh auth refresh` で再発行するか、後述の専用 PAT 方式に切り替える

#### ローテーション時の差し替え手順

1. GitHub Web UI で新しいトークンを発行する
   （**Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token**）。
   スコープは[前提条件](#github-personal-access-tokenpat)の表と同じ（`repo` / `workflow`、必要なら `delete_repo`）
2. Backstage を起動しているシェルで環境変数を差し替え、backend を再起動する

   ```bash
   # Backstage を停止（Ctrl+C）してから
   export GITHUB_TOKEN="<新しいPAT>"   # 値を履歴に残したくない場合は read -rs GITHUB_TOKEN && export GITHUB_TOKEN
   yarn start
   ```

3. [動作確認](#ローテーション--失効後の動作確認)を行う
4. 新トークンでの動作確認後、旧トークンを GitHub Web UI から **Delete** する（新旧併存期間を最短にする）

### 漏洩時の失効手順（インシデント対応）

漏洩（`.env` のコミット、ログ・画面共有への露出など）が疑われる場合は、**確認より失効を優先**して直ちに実施します。

1. **GitHub 上で PAT を失効する**
   - 専用 PAT の場合: **Settings → Developer settings → Personal access tokens → Tokens (classic)** で該当トークンを **Delete**
   - `gh auth token` 転用の場合: `gh auth logout` でセッションを破棄するか、
     **Settings → Applications → Authorized OAuth Apps → GitHub CLI** で認可を **Revoke** する
2. **Backstage 側の環境変数を破棄する**
   - Backstage backend を停止し、起動シェルで `unset GITHUB_TOKEN` する
   - シェル履歴に `export GITHUB_TOKEN="..."` の形で値が残っていないか確認し、残っていれば履歴から削除する
3. **影響を確認する**
   - [Security log](https://github.com/settings/security-log) で漏洩疑い時刻以降の不審な操作（リポジトリ作成・削除、設定変更、SSH キー / PAT の追加）がないか確認する
   - 身に覚えのないリポジトリ・コミット・workflow 実行がないか確認する（PAT は `repo` / `workflow` スコープを持つため）
   - 不審な操作があった場合はパスワード変更と他の credential（SSH キー、その他 PAT）の棚卸しまで実施する
4. 復旧する場合は、[ローテーション時の差し替え手順](#ローテーション時の差し替え手順)に従って新しいトークンを発行・注入する

### ローテーション / 失効後の動作確認

新しいトークンで Scaffolder が動作することを確認します。

```bash
# 新トークンのスコープ確認（repo / workflow があること）
curl -sS -o /dev/null -D - -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user | grep -i x-oauth-scopes
```

1. `GITHUB_TOKEN` を差し替えたシェルで Backstage を再起動する（[実行手順](#実行手順)参照）
2. **Service Baseline (Golden Path)** テンプレートを検証用リポジトリ名で実行し、`publish:github` ステップが成功することを確認する
3. 検証で作成したリポジトリは[検証後の片付け（destroy）](#検証後の片付けdestroy)に従って削除する
4. 失効対応の場合は、旧トークンが GitHub 上で失効済み（一覧に存在しない、または API が `401 Bad credentials` を返す）であることを確認する

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
