# This dockerfile builds an image for the backend package.
#
# ビルドコンテキストは「リポジトリルート」（backstage/ ではない）。
# カタログ実データ（catalog/ / catalog-info.yaml）とゴールデンパステンプレートを
# イメージに同梱するため、upstream の標準 Dockerfile からコンテキストを一段広げている（ADR 0009）。
#
# Before building this image, be sure to have run the following commands in backstage/:
#
# yarn install --immutable
# yarn tsc
# yarn build:backend
#
# Build (from the repo root):
#   docker build -t <tag> -f backstage/packages/backend/Dockerfile .

FROM node:24-trixie-slim

# Set Python interpreter for `node-gyp` to use
ENV PYTHON=/usr/bin/python3

# Install isolate-vm dependencies, these are needed by the @backstage/plugin-scaffolder-backend.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends python3 g++ build-essential && \
    rm -rf /var/lib/apt/lists/*

# Install sqlite3 dependencies. You can skip this if you don't use sqlite3 in the image,
# in which case you should also move better-sqlite3 to "devDependencies" in package.json.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends libsqlite3-dev && \
    rm -rf /var/lib/apt/lists/*

# From here on we use the least-privileged `node` user to run the backend.
USER node

# This should create the app dir as `node`.
# If it is instead created as `root` then the `tar` command below will fail: `can't create directory 'packages/': Permission denied`.
# If this occurs, then ensure BuildKit is enabled (`DOCKER_BUILDKIT=1`) so the app dir is correctly created as `node`.
WORKDIR /app

# Copy files needed by Yarn
COPY --chown=node:node backstage/.yarn ./.yarn
COPY --chown=node:node backstage/.yarnrc.yml ./
COPY --chown=node:node backstage/backstage.json ./

# This switches many Node.js dependencies to production mode.
ENV NODE_ENV=production

# This disables node snapshot for Node 20 to work with the Scaffolder
ENV NODE_OPTIONS="--no-node-snapshot"

# Copy repo skeleton first, to avoid unnecessary docker cache invalidation.
# The skeleton contains the package.json of each package in the monorepo,
# and along with yarn.lock and the root package.json, that's enough to run yarn install.
COPY --chown=node:node backstage/yarn.lock backstage/package.json backstage/packages/backend/dist/skeleton.tar.gz ./
RUN tar xzf skeleton.tar.gz && rm skeleton.tar.gz

RUN --mount=type=cache,target=/home/node/.cache/yarn,sharing=locked,uid=1000,gid=1000 \
    yarn workspaces focus --all --production && rm -rf "$(yarn cache clean)"

# Aurora への TLS 接続検証用の RDS CA バンドル（app-config.production.yaml が参照）
ADD --chown=node:node https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem ./rds-global-bundle.pem

# This will include the examples, if you don't need these simply remove this line
COPY --chown=node:node backstage/examples ./examples

# 本番カタログの実データとゴールデンパステンプレート（app-config.production.yaml の locations が参照）
COPY --chown=node:node catalog ./catalog
COPY --chown=node:node catalog-info.yaml ./catalog-info.yaml
COPY --chown=node:node backstage/templates ./templates

# Then copy the rest of the backend bundle, along with any other files we might want.
COPY --chown=node:node backstage/packages/backend/dist/bundle.tar.gz backstage/app-config.yaml backstage/app-config.production.yaml ./
RUN tar xzf bundle.tar.gz && rm bundle.tar.gz

CMD ["node", "packages/backend", "--config", "app-config.yaml", "--config", "app-config.production.yaml"]
