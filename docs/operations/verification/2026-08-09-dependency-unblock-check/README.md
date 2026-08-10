# dependency-unblock-check UNBLOCKED 経路 検証記録 (2026-08-09)

## 経緯

`dependency-unblock-check`（ADR-0013 / Issue #160 / PR #161、commit `77ac694`）は、
新設直後の実測で次までは確認できていた。

- 緑（exit 0）: run 31305995865 で `OK: still blocked（probe 1 件、全て想定どおり失敗）`
- 機構故障の赤（exit 1、検査2 / 3 / 4 / 5）: 実装時に git worktree 上で踏破
- `node --test` 58/58 pass、`sync` を 3 リポジトリの実 `dependabot.yml` に実行して 3 件とも exit 0

**未検証だったのは UNBLOCKED 経路（exit 10）だけ**である。これは「上流が対応したので ignore を外せる」
という、このジョブを作った目的そのものの経路でありながら、自然発生を待つと数か月先まで踏めない。
そこで一時ブランチ `162-verify-unblocked-path` 上に**必ず成功するダミー probe** を仕込み、
`workflow_dispatch` を `--ref` で当該ブランチに向けて実走させ、人工的に発火させた。

このブランチは `main` にマージせず、検証後に削除した。本物の追跡 Issue（#146 等）には一切触れていない。

### ダミー probe に何を選んだか

| 項目 | 値 |
| --- | --- |
| directory | `/backstage` |
| dependency-name | `prettier` |
| spec | `prettier@3` |
| steps | `yarn up prettier@3` → `yarn tsc` |
| 追跡 Issue | #162（検証用スクラッチ Issue。`dependabot-ignore` ラベル付きで作成し、検証後 close） |

「確実に成功する」根拠は、**すでに使っている major を spec に指定した**こと。
`backstage/package.json` の devDependency は `prettier: ^3.9.6`、`backstage/yarn.lock` の解決も 3.9.6 で、
`npm view prettier version` も 3.9.6（3 系が最新メジャー）だった。
したがって `yarn up prettier@3` は現在と同じ 3.9.6 に解決してロックファイルを実質変更せず、必ず成功する。
後続の `yarn tsc` は直前の run 31305995865 の jsdom probe で exit 0 が実測されている手順であり、
prettier の major を動かさない以上ここも落ちない。
`yarn test` は含めず、実行時間を抑えた（jsdom probe が exit 1 になる原因のステップでもある）。

なお最新メジャー（3）と台帳 spec の major（3）が一致するため、Job Summary の
「最新が spec より先に進んでいる」警告も出ない状態を意図的に選んでいる。

### 一時ブランチ上でのみ行った変更

- `.github/dependabot.yml`: `/backstage` の ignore に `prettier` のダミーエントリを追加
  （7 項目コメントの正典書式に従い、`# 見直し期限: 2026-11-02` / `# 追跡: Issue #162` を各 1 行含む）
- `scripts/ci/dependabot-unblock.json`: 上記に対応する台帳エントリを追加
- `scripts/ci/dependabot-unblock-check.test.mjs`: 台帳 2 エントリ化に追随させる最小修正
  - `runSync` / `runFull` 系のテストは**フィクスチャではなく実リポジトリの台帳と `dependabot.yml`** を読むため、
    エントリを 1 件足すとフェイク GitHub が #162 を知らずに落ちる。`fakeGitHub` の既定 `issues` / `labeled` に
    #162 を追加し、「全 probe が失敗する」テストの `failingStep` を両エントリ共通の `yarn tsc` に変えた
  - **フィクスチャ（`scripts/ci/fixtures/dependabot/*.yml`）は変更していない。**
    フィクスチャを変えると抽出スナップショットと `checkLedgerSync` のテストが逆に壊れる

> [!NOTE]
> この「台帳を 1 件足すとテストが落ちる」結合は Issue #165 で解消済み。
> `runSync` / `runFull` のふるまいは `scripts/ci/fixtures/repo/` の偽リポジトリで検証し、
> 実台帳を読むのは番人テスト 1 本だけになった。
> 現在は UNBLOCKED（exit 10）の分岐もダミー probe を仕込まずにローカルで踏める。

## 確認結果

### 1. UNBLOCKED 経路（exit 10）

1 回目の run: <https://github.com/kmryst/idp-golden-path/actions/runs/31306947027>

- conclusion: **failure**（想定どおり。UNBLOCKED は朗報だが赤で通知する設計）
- exit code: **10**

Job Summary 先頭行と Probe 表（実出力）:

```text
## UNBLOCKED: prettier@3.9.6 が通りました — ignore を外せます（#162）
### Probe
| /backstage | jsdom | jsdom@30 | still blocked | `CI=1 yarn test` が exit 1 |
| /backstage | prettier | prettier@3 | unblocked | prettier@3.9.6 で全 step が成功した |
```

ログ末尾（実出力）:

```text
##[error]UNBLOCKED: an ignored dependency now builds. Remove the ignore (see the Job Summary)
##[error]Process completed with exit code 10.
```

jsdom は同じ run の中で `still blocked` のままであり、1 件が unblocked でも他エントリの判定が
巻き込まれないことも同時に確認できた。

### 2. 追跡 Issue へのコメント投稿

```bash
gh issue view 162 --json comments --jq '.comments | length'
# 1
```

投稿されたコメント本文（実物）:

````markdown
<!-- dependency-unblock-check: prettier@3.9.6 -->

`prettier@3.9.6` で `/backstage` のビルド / テストが通りました。この ignore は解除できます。

実行したコマンド:

```
yarn up prettier@3
yarn tsc
```

解除手順は `docs/operations/dependency-unblock-check.md` を参照してください。
`.github/dependabot.yml` の ignore・`scripts/ci/dependabot-unblock.json` の台帳・この Issue の close を同一 PR で行います。

（`dependency-unblock-check` の自動記録。同一解決版では再投稿しません）
````

先頭行に HTML マーカー `<!-- dependency-unblock-check: prettier@3.9.6 -->` が埋まっていることを確認した。

### 3. 連投防止

同じブランチに対して 2 回目を dispatch: <https://github.com/kmryst/idp-golden-path/actions/runs/31307069019>

- conclusion: **failure** / exit code **10**（人間が未対応なので赤のままが正しい）
- Job Summary 先頭行は 1 回目と同一（`## UNBLOCKED: prettier@3.9.6 が通りました — ignore を外せます（#162）`）

```bash
gh issue view 162 --json comments --jq '.comments | length'
# 1
```

**コメントは 1 件のまま増えなかった。** マーカー一致による再投稿抑止が実 GitHub API 相手で機能している。

### 4. 通知の到達

```bash
gh api notifications --jq '.[] | {reason, type: .subject.type, title: .subject.title}'
```

実出力（該当分）:

```json
{"reason":"ci_activity","type":"CheckSuite","title":"Dependency Unblock Check workflow run failed for 162-verify-unblocked-path branch"}
{"reason":"ci_activity","type":"CheckSuite","title":"Dependency Unblock Check workflow run failed for 162-verify-unblocked-path branch"}
```

2 回の run に対応する失敗通知が 2 件、`ci_activity` として実際に届いていた。
これで「朗報を赤にする（＝ Actions の失敗通知に載せる）」という ADR-0013 の設計前提が実測で裏づけられた。

**ユーザー確認欄**（エージェントからは観測できないため人間が確認した。2026-08-10 記入）:

- [x] メールで失敗通知を受信したか: **到達**。ユーザーが受信を確認
- [x] GitHub UI（ベルアイコン）に通知が出ていたか: **到達**。上記 `gh api notifications` の
      `ci_activity` 2 件が受信箱に実際に入っていたことで確認

したがって「朗報を赤にする（＝ Actions の失敗通知で人に届ける）」という ADR-0013 の設計前提は、
メールと GitHub UI の両経路で実測により裏づけられた。**未確認事項ではない。**

### 5. 後片付け

```bash
gh api "search/issues?q=user:kmryst+is:issue+is:open+label:dependabot-ignore" --jq '.total_count'
# 8
```

- 一時ブランチ `162-verify-unblocked-path`: ローカル・リモートとも削除済み
- スクラッチ Issue #162: close 済み
- 3 リポジトリ横断の `dependabot-ignore` OPEN Issue 数: 検証中は一時的に 9 件、close 後に **8 件へ復帰**
- `main` の作業ツリー: 差分なし

## 既検証（参照）

次は実装時（PR #161）に git worktree 上で踏破済みのため、本記録では繰り返さない。

| 検査 | 内容 | 結果 |
| --- | --- | --- |
| 検査2 | `review-by` / 追跡 Issue の値が台帳と `dependabot.yml` で不一致 | exit 1（MECHANISM） |
| 検査3 | 追跡 Issue に `dependabot-ignore` ラベルが付いていない | exit 1（MECHANISM） |
| 検査4 | ラベル付き OPEN Issue が台帳にない（同時発火） | exit 1（MECHANISM） |
| 検査5 | 見直し期限を過ぎている | exit 1（MECHANISM） |

緑（exit 0）は main マージ後の run 31305995865 で実測済み。

## 未実施

- **`schedule` 実行での失敗通知**。`schedule` は default branch からしか発火せず、
  任意のタイミングで人工的に起こせないため。今回確認したのは `workflow_dispatch` 由来の
  失敗通知であり、通知経路そのものは同じ CheckSuite だが、`schedule` 起動での実測は別途必要。
  来週月曜（`15 1 * * 1` = 10:15 JST）の初回実行で、`schedule` が発火すること自体は確認できる。
