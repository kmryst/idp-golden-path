# Trivy Image Scan の自己テスト用フィクスチャ（primary）
#
# 本リポジトリ自身のアプリケーションイメージではない。
# trivy-image.yml は workflow_call 専用で、本リポジトリの pull_request では起動しない
# （本リポジトリの Dockerfile はホスト側の yarn ビルドを前提とし、素の docker build に乗らない）。
# そのため、reusable workflow 自身の回帰を本リポジトリで検知するための最小フィクスチャを置く。
#
# 意図:
#   - ビルドは数秒で終わる（レイヤーを足さない）
#   - ベースイメージ由来の CRITICAL/HIGH finding が必ず出るので、
#     「0 件だから緑」なのか「検出できていないから緑」なのかを区別できる
#   - secondary/ とは別のベースイメージにしてあり、SARIF の category 分離が
#     効いていないと片方の結果が消えることを検証できる
#
# ベースは ticket-c2c-platform の 2 イメージと同じ node:24-slim（Debian bookworm 系）。
FROM node:24-slim

CMD ["node", "--version"]

# Trivy Config Scan（本リポジトリの PR チェック）が DS-0002 "Image user should not be root"
# を検出しないよう、フィクスチャ自身も非 root で終える。
USER node
