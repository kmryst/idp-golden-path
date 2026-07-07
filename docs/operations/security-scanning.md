# セキュリティスキャン運用

CI で実行するセキュリティスキャン（secret 検出 / 依存関係脆弱性監査 / SAST）の運用の正本です。
severity 閾値・fail/warn ポリシー・検出時の対応フローを変更する場合は、対象 workflow と同じ PR でこのドキュメントを更新します。

required status checks との関係は [branch-protection.md](./branch-protection.md) を参照してください。

## スキャンの全体像と役割分担

| workflow | 検出対象 | 実行タイミング | 検出時の扱い |
| --- | --- | --- | --- |
| [Gitleaks Secret Scan](../../.github/workflows/security-scan.yml) | git 履歴への secret / credential 混入 | PR | fail（required status check） |
| [Dependency Audit](../../.github/workflows/dependency-audit.yml) | `backstage/` 依存関係の既知脆弱性（CVE） | PR / 週次（月曜 09:00 JST）/ 手動 | high 以上で fail、moderate 以下は警告のみ |
| [CodeQL](../../.github/workflows/codeql.yml) | コード起因の脆弱性（SAST） | PR / main push / 週次（月曜 09:00 JST） | Security > Code scanning alerts に集約（CI は解析失敗時のみ fail） |

3 つのスキャンは検出レイヤーが異なり、相互に代替できません。

- **Gitleaks**: 「自分が書いたもの」に秘密情報が混入していないか（コミット内容の検査）
- **Dependency Audit**: 「他人が書いたもの（依存パッケージ）」に既知の脆弱性がないか（サプライチェーンの検査）
- **CodeQL**: 「自分が書いたもの」に脆弱なコードパターンがないか（静的解析）

なお Dependabot version updates（`.github/dependabot.yml`）は「新しいバージョンが出たら更新 PR を作る」仕組みであり、
既知脆弱性（CVE）の検出・警告は Dependency Audit が担います。

## Dependency Audit

- 対象: `backstage/`（Yarn workspaces）。ルートの npm 依存（lint ツール類）は Dependabot の更新で追従する
- コマンド: `yarn npm audit --all --recursive`（全 workspace + 推移的依存を監査）
- schedule 実行があるため、PR が無い期間に公開された新規 CVE も週次で検出できる

### severity 閾値と fail/warn ポリシー

| severity | 扱い |
| --- | --- |
| critical / high | CI fail（`--severity high` ゲート） |
| moderate / low / info | fail させない。全 severity の監査結果を Step Summary に出力して可視化のみ |

moderate 以下を fail させないのは、Backstage 本体の依存グラフが大きく、
修正版が上流に存在しない低 severity の検出で PR が恒常的にブロックされるのを避けるためです。

### 検出時の対応フロー

1. Step Summary で該当 advisory（パッケージ名・severity・修正版の有無）を確認する
2. 修正版がある場合: 依存の更新で解消する
   - 直接依存: `backstage/package.json` のバージョン更新（Dependabot PR があればそれを優先）
   - 推移的依存: `backstage/package.json` の `resolutions` で修正版に固定する
3. 修正版が無い / 即時対応できない場合（例外運用）:
   - Issue を起票して追跡し、`yarn npm audit` の `--exclude <advisory ID>`（workflow 側に理由コメント付きで追記）で一時的に除外する
   - 除外は恒久化させず、修正版リリース後に除外を外す PR を作る
4. schedule 実行での検出（PR 起因でない新規 CVE）も同じフローで、Issue 起票から始める

## CodeQL

- 解析言語: `javascript-typescript`（Backstage アプリ本体）と `actions`（GitHub Actions workflow）。build-mode は `none`（ビルド不要のスキャン）
- public リポジトリのため CodeQL は無料で利用できる
- リポジトリ側の CodeQL default setup は使わず、この workflow（advanced setup）を正本とする。default setup を有効化すると衝突するため併用しない

### 検出時の対応フロー

1. Security > Code scanning alerts で該当 alert（ルール ID・該当箇所・severity）を確認する
2. 原則としてコード修正で解消する
3. false positive の場合: alert を Dismiss し、理由（False positive / Used in tests / Won't fix）を必ず選択する
4. alert の存在自体は PR をブロックしない（後述）。critical / high の alert は Issue を起票して追跡する

## required status checks との関係

現時点では Dependency Audit / CodeQL を required status checks に**昇格させません**
（[branch-protection.md](./branch-protection.md) の required checks は従来どおり）。

- Dependency Audit の fail 要因（新規公開 CVE）は PR の変更内容と無関係に発生するため、
  required にすると無関係な PR が突然マージ不能になる。まず非 required で運用し、検出頻度を見てから昇格を判断する
- CodeQL は alert 集約型で、PR ブロックには branch protection 側の Code scanning 設定が別途必要。こちらも運用実績を見てから判断する

昇格する場合は別 Issue で扱い、`branch-protection.md` の設定変更と同じ PR でこのドキュメントを更新します。
