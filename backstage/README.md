# [Backstage](https://backstage.io)

This is your newly scaffolded Backstage App, Good Luck!

To start the app, run:

```sh
yarn install
yarn start
```

`yarn start` loads `app-config.yaml` and `app-config.development.yaml`.
If `app-config.local.yaml` exists, it is loaded as an additional local override.

## CI

`backstage/` 配下に変更がある PR では、`Backstage CI`（`.github/workflows/backstage-ci.yml`）が実行されます。
CI はローカルで実行できる以下の yarn コマンドと同じ検証を行います（Node.js 24 / `yarn install --immutable`）。

```sh
yarn tsc        # 型チェック
yarn config:check # development / production config 検証
yarn lint:all   # backstage-cli repo lint
yarn test       # backstage-cli repo test
yarn build:all  # backstage-cli repo build --all
```
