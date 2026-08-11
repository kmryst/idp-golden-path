# Trivy Image Scan の自己テスト用フィクスチャ（secondary）
#
# 用途は primary/Dockerfile のヘッダコメントを参照。
# SARIF の category 分離を検証するため、primary とは検出内容が異なるベースイメージにする。
#
# ベースは本リポジトリ自身の backstage backend イメージと同じ node:24-trixie-slim
# （Debian trixie 系）。primary の node:24-slim とは OS パッケージ構成が異なる。
FROM node:24-trixie-slim

CMD ["node", "--version"]

# Trivy Config Scan（本リポジトリの PR チェック）が DS-0002 "Image user should not be root"
# を検出しないよう、フィクスチャ自身も非 root で終える。
USER node
