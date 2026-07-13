# 0002. 既存 2 リポジトリの軽運用 / 厳密運用 GitHub Flow モデルを踏襲する

## ステータス

Accepted

## 日付

2026-07-07

## 決定内容

`idp-golden-path` の開発フローとして、[terraform-hannibal](https://github.com/kmryst/terraform-hannibal)（ADR 0010）で確立し [ticket-c2c-platform](https://github.com/kmryst/ticket-c2c-platform) でも踏襲した、軽運用 / 厳密運用を分ける GitHub Flow モデルを採用する。

- すべての変更に共通の最低限のゲート（Issue リンク、必須 4 ラベル、PR、required status checks）を課す
- 軽微な変更（軽運用）は Issue / PR 本文を最小限に保ち、速度を落とさない
- リスクの高い変更（厳密運用）はロールバック手順と影響範囲の明示を求める
- `main` への direct push は branch protection で禁止し、squash merge する

運用ルールの具体（必須ラベル、`Closes / Fixes / Refs` 記法、厳密運用の判定基準）の正本は `CONTRIBUTING.md` とする。設計意図、未採用案、将来の再検討条件は `docs/operations/github-flow-guardrails.md` に置く。CI（PR Policy Check / Commitlint / Markdown Lint / Gitleaks）と helper scripts（`scripts/github/`）も既存 2 リポジトリから移植する。

## 背景

このリポジトリは 3 つ目のポートフォリオであり、既存 2 リポジトリで「ADR ドリブンな意思決定」「厳密な GitHub Flow」「Claude Code 運用ルール」という一貫したスタイルが確立済みである。

さらにこのリポジトリの主題は、まさにこの運用基盤を IDP のゴールデンパスとして抽象化することにある（ADR 0001）。抽象化対象である運用基盤そのものを、このリポジトリでも一貫して実践しておくことは、テンプレート化の入力（実績のあるリファレンス実装）としても必要になる。

## 検討した選択肢

### 既存モデルの踏襲（採択）

- 長所: 3 リポジトリで運用スタイルが揃い、ポートフォリオ全体の一貫性を示せる
- 長所: 実績のある CI・helper・テンプレートを移植でき、立ち上げコストが低い
- 長所: このリポジトリで抽象化する「ゴールデンパス」の実物リファレンスになる
- 短所: アプリコードがない初期段階には、やや過剰なゲートになる

### 個人ドキュメントリポジトリ運用（Issue / PR なしで main へ直接 push）

- 長所: 構想段階では最速
- 短所: 変更の意図・履歴が追跡できず、ポートフォリオとして開発プロセスを示せない
- 短所: 後から厳密運用へ移行するコストが発生する

### 新しい運用モデルをゼロから設計する

- 長所: IDP の題材として運用設計そのものを見せられる
- 短所: 既存 2 リポジトリとの一貫性が失われ、再発明（このリポジトリが解決したい課題そのもの）になる

## 採択理由

このリポジトリの目的が「運用基盤の再発明をなくす」ことである以上、自らも実績のあるモデルを再利用するのが最も一貫している。初期段階にはやや過剰でも、CI とテンプレートは移植で安く手に入り、Backstage 実装が始まった時点でそのまま効いてくる。

CI は現段階の実態（ドキュメント中心・アプリコードなし）に合わせ、PR Policy Check / Commitlint / Markdown Lint / Gitleaks の最小構成とし、Backstage 実装が入った段階でビルド・テスト系チェックを追加する。

## 影響

- Issue / PR には `type / area / risk / cost` の必須 4 ラベルを付ける
- `.github/workflows/**`、`scripts/github/**`、`terraform/**`、リポジトリ設定変更などは厳密運用とし、PR 本文にロールバック手順を書く
- branch protection（required status checks / direct push 禁止 / enforce_admins）を main に適用し、設定は `docs/operations/branch-protection.md` に記録する
- Backstage 実装開始時に、ビルド・テスト系 CI の追加と required checks の昇格を再検討する

## 関連

- [Issue #10](https://github.com/kmryst/idp-golden-path/issues/10)
- [terraform-hannibal ADR 0010](https://github.com/kmryst/terraform-hannibal/blob/main/docs/adr/0010-adopt-lightweight-and-strict-github-flow.md)
- [CONTRIBUTING.md](https://github.com/kmryst/idp-golden-path/blob/main/CONTRIBUTING.md) - 運用ルールの正本
- [GitHub Flow Guardrails](../operations/github-flow-guardrails.md) - 設計意図、未採用案、将来の再検討条件
- [docs/operations/branch-protection.md](../operations/branch-protection.md)
