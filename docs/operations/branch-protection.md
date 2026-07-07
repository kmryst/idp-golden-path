# main ブランチ保護設定

`main` ブランチの branch protection 設定の記録です。
GitHub リポジトリ設定は Terraform 管理していないため、このドキュメントを設定内容の正本として扱い、変更時は必ず同じ PR で更新します。

運用モデル（軽運用 / 厳密運用 GitHub Flow）の採用理由は [ADR 0002](../adr/0002-adopt-lightweight-and-strict-github-flow.md) を参照してください。

## 現在の設定

| 項目 | 値 |
| --- | --- |
| required status checks | `PR Policy Check` / `Commitlint` / `Markdown Lint` / `Gitleaks Secret Scan` |
| strict（Require branches to be up to date） | false |
| enforce_admins | true |
| required_approving_review_count | 0 |
| require_code_owner_reviews | false |
| allow_force_pushes | false |
| allow_deletions | false |
| required_linear_history | false |
| required_conversation_resolution | true |

- 少人数運用のため approving review は必須にしない（terraform-hannibal と同方針）。品質ゲートは required status checks と PR 作成前の計画確認で担保する
- required status checks の名称は、各 workflow の **job の `name`** と一致させる必要がある。workflow 側で job name を変える場合は、必ずこの設定も同じタイミングで更新する

## 適用コマンド

```bash
gh api -X PUT repos/kmryst/idp-golden-path/branches/main/protection \
  --input - <<'EOF'
{
  "required_status_checks": {
    "strict": false,
    "checks": [
      { "context": "PR Policy Check" },
      { "context": "Commitlint" },
      { "context": "Markdown Lint" },
      { "context": "Gitleaks Secret Scan" }
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
gh api repos/kmryst/idp-golden-path/branches/main/protection | jq '{
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
