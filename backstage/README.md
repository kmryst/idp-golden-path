# [Backstage](https://backstage.io)

This is your newly scaffolded Backstage App, Good Luck!

To start the app, run:

```sh
yarn install
yarn start
```

## CI

`backstage/` 配下に変更がある PR では、`Backstage CI`（`.github/workflows/backstage-ci.yml`）が実行されます。
CI はローカルで実行できる以下の yarn コマンドと同じ検証を行います（Node.js 24 / `yarn install --immutable`）。

```sh
yarn tsc        # 型チェック
yarn lint:all   # backstage-cli repo lint
yarn test       # backstage-cli repo test
yarn build:all  # backstage-cli repo build --all
```
