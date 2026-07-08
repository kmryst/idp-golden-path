# 本番デプロイ検証記録 (2026-07-08)

## 経緯

Production Deploy workflow を4回実行し、以下の順で権限不足を解消した。

1. run 28961483132: shared 層 IPAM プールで失敗（PR #73, tier="advanced" で解消済み）
2. run 28962126705: ephemeral 層 RDS Aurora 作成が `KMSKeyNotAccessibleFault` で失敗
   → PR #75 で permissions boundary に KMS 権限追加（効果なし）
   → PR #76 で KMS 権限を identity policy 側に移動（root cause: boundary は上限のみ、
   実際の許可には identity policy 側の Allow が必要）
3. run 28963820526: `secretsmanager:CreateSecret` 権限不足で失敗
   → PR #77 で identity policy に `secretsmanager:CreateSecret` / `TagResource` を追加
4. run 28964325805: **全ステップ成功**（所要 13m2s）
   https://github.com/kmryst/idp-golden-path/actions/runs/28964325805

## 確認結果

### 1. HTTPS 疎通 / readiness

```
curl -s -o /dev/null -w '%{http_code}' https://idp-golden-path.click/.backstage/health/v1/readiness
→ 200
```

### 2. GitHub OAuth ログイン

- トップページ（`01-login-page.png`）: Sign In ボタン表示、正常
- Sign In クリック → GitHub OAuth 認可画面へのリダイレクトを確認（`02-github-oauth-redirect.png`）
  - `client_id=Ov23lioqb4z5WBJzZrcr`
  - `redirect_uri=https://idp-golden-path.click/api/auth/github/handler/frame`
  - `scope=read:user`
  - いずれも persistent 層の GitHub OAuth App 設定と一致し、OAuth 配線自体は正しく機能している。
- `/catalog` への直接アクセスも未認証時はサインインゲートにリダイレクトされることを確認
  （意図した認可ゲートが機能している）。

**未完了**: 実際の GitHub アカウントでの対話的ログイン完了、および認証後の Catalog / TechDocs
画面表示の確認は、実ユーザー（komurayoshitodesu）の GitHub 認証情報が必要なため、
このセッション（エージェント）では代行できていない。パスワード/2FA等の入力はエージェントが
保持すべきでないため、意図的に停止した。

対話的ログイン完了・Catalog/TechDocs目視確認は実ユーザー認証情報が必要なため今回は未実施。
パイプライン自体（deploy成功、readiness、OAuthリダイレクト配線）は検証済み。
ユーザーは深夜で不在（就寝中）、かつ「検証時のみ apply → destroy する」運用方針
（CLAUDE.md / ADR 0009）を優先し、ログイン待ちで本番インフラを稼働させ続けることは
しない判断とした。

## 未実施

- Catalog エンティティ一覧の表示確認（ログイン後、実ユーザーによる確認が必要）
- TechDocs 表示確認（ログイン後、実ユーザーによる確認が必要）

## 証跡ファイル

- `01-login-page.png`: トップページ（Sign In ボタン）
- `02-github-oauth-redirect.png`: GitHub OAuth 認可画面へのリダイレクト
