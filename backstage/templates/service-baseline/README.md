# service-baseline — ゴールデンパステンプレート

新規サービスリポジトリを「リポジトリ・ガバナンスベースライン」つきで作成する
Backstage Scaffolder テンプレートです。設計判断は
[ADR-0006](../../../docs/adr/0006-scaffolder-service-baseline-template.md) を参照してください。

## 構成

```text
service-baseline/
├── template.yaml   # parameters / steps / output の定義（Catalog に Template として登録）
└── skeleton/       # fetch:template で展開されるひな形一式
```

## テンプレートが生成するもの

- `CLAUDE.md` / `CONTRIBUTING.md` — 軽運用 / 厳密運用 GitHub Flow・必須 4 ラベル・Conventional Commits
- `.github/labels.yml` + Sync Labels workflow — ラベル定義のコード管理
- CI workflows — PR Policy Check / Commitlint / Markdown Lint / Gitleaks Secret Scan
- `.github/pull_request_template.md` / `ISSUE_TEMPLATE/` — PR / Issue テンプレート
- `scripts/github/` — Issue / PR 作成・ラベル同期・ブランチ cleanup helper
- `docs/adr/` — ADR 運用ルールと生成経緯を記録した ADR-0001
- `docs/operations/branch-protection.md` — main ブランチ保護の適用手順（生成直後は未適用）
- `mkdocs.yml` / `catalog-info.yaml` — TechDocs / Software Catalog 対応

## パラメータ

| パラメータ | 必須 | 内容 |
| --- | --- | --- |
| `name` | yes | サービス名（小文字英数字とハイフン）。リポジトリ名・カタログ登録名になる |
| `description` | yes | サービスの説明。README / catalog-info / GitHub の description に反映される |
| `owner` | yes | カタログ上のオーナー Group（OwnerPicker） |
| `lifecycle` | no | `experimental`（default）/ `production` |
| `repoUrl` | yes | 公開先（`github.com` のみ許可、RepoUrlPicker） |
| `repoVisibility` | no | `private`（default）/ `public` |

## skeleton 編集時の注意

- `${{ values.* }}` は nunjucks で展開される。GitHub Actions 式（`${{ github.* }}` など）や
  bash の `${#array[@]}`（nunjucks のコメント開始 `{#` と衝突する）を含むファイルは、
  `template.yaml` の `copyWithoutTemplating`（`.github/workflows/**` / `.github/actions/**` / `scripts/github/**`）に含めて無変換コピーすること
- skeleton は本リポジトリの `CLAUDE.md` / `CONTRIBUTING.md` / `.github/**` / `scripts/github/**` のコピーを含む。
  本体側を変更する PR では skeleton への追随要否を確認すること（ADR-0006「影響」）
- skeleton 配下の Markdown は本体の markdownlint 対象外（`backstage/**` は ignore）

## ローカルでの実行方法・前提条件（GitHub PAT 等）

リポジトリルートの [README.md](../../../README.md) と
[docs/operations/scaffolder-github-integration.md](../../../docs/operations/scaffolder-github-integration.md) を参照してください。
