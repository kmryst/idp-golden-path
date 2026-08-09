# Dependency Unblock Check 運用

Dependabot の `ignore` が「もう外せる」状態になっていないかを週次で実測し、
`dependabot.yml` の ignore・サイドカー台帳・追跡 Issue の三者の食い違いを検出する仕組みの運用正本です。

設計判断の背景は [ADR-0013](../adr/0013-dependency-unblock-check.md) を参照してください。
脆弱性スキャン（`npm audit` / `yarn audit` / 期限付き例外）の正本は
[security-scanning.md](./security-scanning.md) です。用途が別なので混ぜません。

## 構成要素

| ファイル | 役割 |
| --- | --- |
| `.github/workflows/dependency-unblock-check.yml` | 週次 schedule + `workflow_dispatch` + `workflow_call` の reusable workflow |
| `scripts/ci/dependabot-unblock-check.mjs` | 評価器（外部依存ゼロ）。`sync` / `full` のサブコマンドを持つ |
| `scripts/ci/dependabot-unblock-check.test.mjs` | `node --test` による単体テスト |
| `scripts/ci/dependabot-unblock.json` | 台帳（本リポジトリ分） |
| `scripts/ci/fixtures/dependabot/*.yml` | 3 リポジトリの `dependabot.yml` 実ファイルのコピー（抽出器のテスト用） |

## 赤緑の読み方

**このジョブの赤緑は「危険 / 安全」ではなく「人間の出番か否か」です。**

| Job Summary 先頭行 | exit | 意味 | やること |
| --- | --- | --- | --- |
| `OK: still blocked（probe N 件、全て想定どおり失敗）` | 0（緑） | 上流はまだ追いついていない。機構も健全 | なし |
| `UNBLOCKED: <name>@<解決版> が通りました — ignore を外せます（#NNN）` | 10（赤） | **朗報**。上流が対応し、実際にビルド / テストが通った | ignore 解除 PR を出す（下記） |
| `MECHANISM: <詳細>` | 1（赤） | 機構の故障。ignore / 台帳 / Issue / ラベルのどれかが食い違っている | 下の対処表を参照 |

複数の事象が同時に起きた場合は `MECHANISM` を優先して表示します。
機構が壊れている間は probe の結果自体が信用できないため、probe は実行しません。

朗報を赤にしているのは、新しい通知インフラを足さずに人へ確実に届く唯一の経路が
GitHub Actions の失敗通知だからです。上流対応は数か月に一度なので、この赤は稀です。

## 赤（MECHANISM）の理由と対処

| 検査 | Summary の文言 | 何が起きたか | 対処 |
| --- | --- | --- | --- |
| 1 | `追跡 Issue #NNN が closed になっている` | ignore が残っているのに追跡 Issue を閉じた | ignore を外すなら台帳と `dependabot.yml` も同一 PR で外す。残すなら Issue を reopen する |
| 2 | `... に対応する ignore が dependabot.yml にない` | 台帳にあるが ignore がない | 台帳エントリを削除するか、ignore を復活させる |
| 2 | `... が台帳に未収載` | ignore を足して台帳を書き忘れた | 台帳へ追記する（`probe: false` でも記載必須） |
| 2 | `review-by が不一致` / `追跡 Issue が不一致` | 片方だけ更新した | `dependabot.yml` のコメントを正本として台帳を合わせる |
| 3 | `追跡 Issue #NNN に dependabot-ignore ラベルが付いていない` | ラベルの付け忘れ | 追跡 Issue に `dependabot-ignore` を付ける |
| 4 | `dependabot-ignore ラベル付き OPEN Issue #NNN が台帳にない` | ignore を外したのに Issue を閉じ忘れた、または台帳漏れ | Issue を close するか、台帳へ追記する |
| 5 | `見直し期限 YYYY-MM-DD を過ぎている` | デッドマンスイッチ作動 | 状況を再評価し、期限を更新する PR を出す（無言の期限延長はしない） |

評価器が想定外の構造に出会った場合（`dependabot.yml` のインデント崩れ、`versions:` 形式の ignore、
コメント行の欠落 / 重複など）も `MECHANISM` で赤になります。これは fail closed の設計です。

## 台帳スキーマ

`scripts/ci/dependabot-unblock.json` は JSON 配列です。

```json
[
  {
    "directory": "/backstage",
    "dependency-name": "jsdom",
    "probe": true,
    "spec": "jsdom@30",
    "steps": ["yarn up jsdom@30", "yarn tsc", "CI=1 yarn test"],
    "review-by": "2026-11-02",
    "tracking": "https://github.com/kmryst/idp-golden-path/issues/146"
  }
]
```

| キー | 必須 | 内容 |
| --- | --- | --- |
| `directory` | 常に | `dependabot.yml` の `directory` と完全一致させる（`/` 始まり） |
| `dependency-name` | 常に | `dependabot.yml` の `dependency-name` と完全一致させる |
| `probe` | 常に | 実際に上げて試すか |
| `spec` | `probe: true` のみ | 試すメジャーを**固定**して書く（`jsdom@30`）。`@latest` にしない |
| `steps` | `probe: true` のみ | 逐次実行するシェルコマンド。非空 |
| `probe-skip-reason` | `probe: false` のみ | なぜ試さないか |
| `review-by` | 常に | `dependabot.yml` コメントの見直し期限と完全一致させる |
| `tracking` | 常に | 追跡 Issue の完全 URL。同一リポジトリを指すこと。**重複を許容する** |

補足:

- `probe: false` のエントリも**台帳に必須**です。検査2 の 1:1 対応を成立させるためで、「試さないから書かない」は認めません。
  解除条件が「自リポジトリ側の作業待ち」や「方針」である ignore は、試しても永久に失敗して誤報になるため `probe: false` にします
- `tracking` の重複は正常です（例: terraform-hannibal の `/` と `/client` の 2 エントリが同一 Issue を指す）
- `spec` を固定するのは、`@latest` だと「7 は通るが 8 は通らない」ときに判定が曖昧になるためです。
  最新メジャーが `spec` より先に進むと Job Summary で警告が出るので、その時点で `spec` の更新を検討します
- probe は各エントリの前後で対象ディレクトリを
  `git checkout -- . && git clean -fd -e .idp-golden-path-workflow` + `node_modules` 削除でリセットします
  （消費側で `directory` が `/` のとき、評価器の sparse checkout を消さないための除外です）
- probe の子プロセスには `GITHUB_TOKEN` / `GH_TOKEN` / `NODE_AUTH_TOKEN` / `NPM_TOKEN` を渡しません。
  未検証の新メジャーとその推移依存を実行する仕組みであるためです

## `dependabot.yml` コメントの正典書式

評価器は `dependabot.yml` を行ベースで抽出します（外部依存ゼロ規約のため full YAML パーサは使いません）。
各 `- dependency-name:` エントリの**直前のコメントブロック**に、次の 2 行を**各 1 行ちょうど**含めてください。
0 行でも 2 行以上でも赤になります。

```yaml
    ignore:
      # <なぜ ignore するか。実測根拠。本番影響。解除条件…（7 項目コメント）>
      # 見直し期限: 2026-11-02（他リポジトリの棚卸し時期と揃える）
      # 追跡: Issue #146
      - dependency-name: "jsdom"
        update-types: ["version-update:semver-major"]
```

- 抽出正規表現: `見直し期限:\s*(\d{4}-\d{2}-\d{2})` / `追跡:\s*Issue #(\d+)`
- **見直し期限の正本は `dependabot.yml` のコメント側**です。期限超過判定もこちらの日付で行います
- `versions:` 形式の ignore は規約外です（`update-types` のみ）。書くと赤になります
- `ignore:` はブロックシーケンスで書きます。flow style（`ignore: [{...}]`）やクォート付きキーは赤になります
  （見逃すと「台帳にも追跡 Issue にも載らない ignore」が成立してしまうため）
- ファイル先頭の横断検索リンクコメントは、いずれのエントリにも帰属しません

## ラベル運用

追跡 Issue には `dependabot-ignore` ラベルを付けます。3 リポジトリ横断の有効な ignore 一覧は
このラベルの検索で得ます（各 `dependabot.yml` の先頭にリンクがあります）。

- 追跡 Issue を起票したら、その場で `dependabot-ignore` を付ける（付け忘れは検査3 で赤）
- ignore を解除するときは、`dependabot.yml` の ignore・台帳エントリ・追跡 Issue の close を**同一 PR**で行う
- ラベルだけ外して Issue を OPEN のまま残さない（検査4 が空振りする）

## `UNBLOCKED`（赤 exit 10）が出たときの手順

1. Job Summary の probe 表と、追跡 Issue に自動投稿された記録コメントを読む
2. 該当の ignore を `.github/dependabot.yml` から削除する
3. 台帳（`scripts/ci/dependabot-unblock.json`）の該当エントリを削除する
4. 実際に依存を上げ、ビルド / テストが通ることを PR の CI で確認する
5. 追跡 Issue を close する（同一 PR の `Closes #NNN` でよい）

同一の解決版に対する記録コメントは 1 度しか投稿されません。対応するまで毎週赤が続きますが、
コメントは増えません。赤が続くこと自体が「まだ人間が対応していない」という正しい表現です。

## ローカルでの実行

```bash
# ファイル検査のみ（ネットワークなし・コマンド実行なし）
node scripts/ci/dependabot-unblock-check.mjs sync

# 追跡 Issue の検査 + probe まで（GITHUB_TOKEN / GITHUB_REPOSITORY が必要）
GITHUB_REPOSITORY=kmryst/idp-golden-path GITHUB_TOKEN="$(gh auth token)" \
  node scripts/ci/dependabot-unblock-check.mjs full

# 単体テスト
node --test scripts/ci/dependabot-unblock-check.test.mjs
```

`full` は `backstage/` の `package.json` / `yarn.lock` / `node_modules` を書き換えます。
ローカルで試す場合は作業ツリーを汚さないよう、`git worktree` などの使い捨てチェックアウトで実行してください。

## 消費側リポジトリの導入手順

caller は薄く保ち、**トリガーを 3 種に限定**します。

```yaml
name: Dependency Unblock Check

on:
  schedule:
    - cron: "15 1 * * 1"
  workflow_dispatch:

permissions:
  contents: read
  issues: write

concurrency:
  # callee と同一の group 名にするとデッドロック判定で run がキャンセルされる（Issue #106）。
  # 必ず -caller サフィックスなどで区別する
  group: dependency-unblock-check-caller-${{ github.run_id }}
  cancel-in-progress: false

jobs:
  dependency-unblock-check:
    uses: kmryst/idp-golden-path/.github/workflows/dependency-unblock-check.yml@v1
```

導入時のチェックリスト:

- [ ] `pull_request` / `pull_request_target` を**張っていない**（セキュリティ契約。ADR-0013。callee 側でも拒否するので、張ると即 fail する）
- [ ] concurrency group が callee と別名になっている
- [ ] `permissions` に `issues: write` がある（記録コメントの投稿に必要）
- [ ] 消費側リポジトリに `scripts/ci/dependabot-unblock.json` を置いた（`ledger-path` input で場所を変えられる）
- [ ] 台帳の全エントリの `tracking` が、そのリポジトリの `dependabot-ignore` ラベル付き OPEN Issue を指している

評価器は reusable workflow と同じ commit から sparse checkout され、`@v1` の実装と一体で固定されます
（`dependency-audit.yml` と同じ方式）。
