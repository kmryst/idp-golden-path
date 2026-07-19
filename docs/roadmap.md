# Roadmap

まだ Issue 化するほど設計が固まっていないが、実装するとプラットフォームとしての価値が上がる拡張候補を記録します。
トレードオフを伴う設計判断が固まった段階で、通常の Issue / ADR 駆動フローに移行します。

## 案3: Supply Chain Security

コンテナイメージの署名・検証によるサプライチェーンセキュリティの強化。

- 独立したプロジェクトとしてではなく、idp-golden-path の reusable workflows として terraform-hannibal / ticket-c2c-platform を含む 3 リポジトリへ配布するのが自然な形。既存の CI ガードレール（[ADR 0008](./adr/0008-ci-guardrails-as-reusable-workflows-with-tag-pinning.md)）と同じ配布パターンに乗せる。
- 「ECR が未署名イメージを拒否する」という表現は正確ではない。ECR 自体にイメージ署名を強制検証する機能はなく、実際には次のような設計になる。
  - デプロイ前の CI ゲートで署名を検証し、未署名イメージのデプロイをブロックする
  - Kubernetes を使う場合は Admission Policy（Kyverno / Sigstore Policy Controller 等）でクラスタ側でも検証する
