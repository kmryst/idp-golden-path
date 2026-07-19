# Roadmap

まだ Issue 化するほど設計が固まっていないが、実装するとプラットフォームとしての価値が上がる拡張候補を記録します。
トレードオフを伴う設計判断が固まった段階で、通常の Issue / ADR 駆動フローに移行します。

## 案3: ソフトウェアサプライチェーンセキュリティ（SLSA / 署名 / SBOM）

コンテナイメージの SLSA provenance 生成・cosign 署名・SBOM 生成によるサプライチェーンセキュリティの強化。

- 独立したプロジェクトとしてではなく、idp-golden-path の reusable workflows として terraform-hannibal / ticket-c2c-platform を含む 3 リポジトリへ配布するのが自然な形。既存の CI ガードレール（[ADR 0008](./adr/0008-ci-guardrails-as-reusable-workflows-with-tag-pinning.md)）と同じ配布パターンに乗せる。
- 「ECR が未署名イメージを拒否する」という表現は正確ではない。ECR 自体にイメージ署名を強制検証する機能はなく、実際にはデプロイ前の CI ゲートで署名を検証し、未署名イメージのデプロイをブロックする設計になる。idp-golden-path / terraform-hannibal / ticket-c2c-platform はいずれも ECS Fargate 上で稼働しており（[ADR 0009](./adr/0009-production-deployment-on-ecs-fargate.md)）Kubernetes の Admission Controller に相当するクラスタ側検証の仕組みはないため、CI パイプライン内の検証で完結させる。
- 証明できること: 「検出型セキュリティ」（脆弱性スキャンで後から気づく）から「予防・証明型セキュリティ」（ビルドの出所と完全性を事前に証明する）への転換を示せる。
- DevSecOps 寄りの拡張であり、単体では規模が小さい。独立した「第4の柱」として立てるより、既存 3 リポジトリの CI ガードレールへの横串強化として位置づける方が実装規模に見合う。
