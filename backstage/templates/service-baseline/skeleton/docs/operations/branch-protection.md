# main ブランチ保護設定

`main` ブランチの branch protection の適用手順と設定内容の正本です。
GitHub リポジトリ設定は Terraform 管理していないため、このドキュメントを設定内容の正本として扱い、変更時は必ず同じ PR で更新します。

> **注意**: このリポジトリは idp-golden-path の service-baseline テンプレートから生成された直後は
> branch protection が**未適用**です。required status checks は各 workflow の初回実行前に設定すると
> PR を恒久的にブロックし得るため、最初の PR で CI（下記 4 check）の実行実績を作ってから適用してください。
> また、private リポジトリでは GitHub のプランによって branch protection が利用できない場合があります。

## 適用する設定

| 項目 | 値 |
| --- | --- |
| required status checks | `PR Policy Check / PR Policy Check` / `Commitlint / Commitlint` / `Markdown Lint / Markdown Lint` / `Gitleaks Secret Scan / Gitleaks Secret Scan` |
| strict（Require branches to be up to date） | false |
| enforce_admins | true |
| required_approving_review_count | 0 |
| require_code_owner_reviews | false |
| allow_force_pushes | false |
| allow_deletions | false |
| required_linear_history | false |
| required_conversation_resolution | true |

- 少人数運用のため approving review は必須にしない。品質ゲートは required status checks と PR 作成前の計画確認で担保する
- CI ガードレールは kmryst/idp-golden-path の reusable workflows をタグ固定（`@v1`）で呼び出しているため、
  check run 名は `<caller job name> / <called job name>`（例: `PR Policy Check / PR Policy Check`）になる。
  required status checks の名称はこの合成名と一致させる必要がある。
  caller 側の job name か reusable workflow 側の job name を変える場合は、必ずこの設定も同じタイミングで更新する

## 適用コマンド

```bash
gh api -X PUT repos/${{ values.destination.owner }}/${{ values.destination.repo }}/branches/main/protection \
  --input - <<'EOF'
{
  "required_status_checks": {
    "strict": false,
    "checks": [
      { "context": "PR Policy Check / PR Policy Check" },
      { "context": "Commitlint / Commitlint" },
      { "context": "Markdown Lint / Markdown Lint" },
      { "context": "Gitleaks Secret Scan / Gitleaks Secret Scan" }
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": false,
  "required_conversation_resolution": true
}
EOF
```

## 確認コマンド

```bash
gh api repos/${{ values.destination.owner }}/${{ values.destination.repo }}/branches/main/protection | jq '{
  checks: .required_status_checks.checks,
  strict: .required_status_checks.strict,
  enforce_admins: .enforce_admins.enabled,
  reviews: .required_pull_request_reviews.required_approving_review_count,
  force_pushes: .allow_force_pushes.enabled,
  deletions: .allow_deletions.enabled
}'
```

## 変更時の注意

- 存在しない check 名を required に指定すると、PR が永久にマージ不能になる。指定前に PR 上で実際の check run 名を確認する
- `Commitlint` / `PR Policy Check` は Dependabot PR ではスキップされる（`if: github.actor != 'dependabot[bot]'`）。Dependabot PR をマージする場合は check の扱いに注意する
- 一時的に保護を外す操作（`gh api -X DELETE .../protection`）は、必ずユーザーの明示的な許可を得てから行う
