# 構成図のソース

`docs/architecture/diagrams/` の構成図（`component-relations.drawio` / `.png`）を生成する作図スクリプトと、その元にした inventory を置く。
置き方は kmryst/felis-ai-chatbot の ADR-0033、kmryst/ticket-c2c-platform の ADR-0044 と同じで、調査担当の報告と公開前の検査に使う deny list / allow list はリポジトリに置かない。

## ファイル

| パス | 内容 |
| --- | --- |
| `inventory.md` | 図の要素と関係の一覧。図に描くかどうかと、その理由・根拠 |
| `gen.py` | drawio を生成する。図に描く内容の正本は `inventory.md` |

## 生成

Python 3 の標準ライブラリだけで動く。リポジトリルートで次を実行する。

```bash
python3 docs/architecture/diagrams/src/gen.py docs/architecture/diagrams/component-relations.drawio
```

PNG への書き出しは draw.io で行い、`docs/architecture/diagrams/component-relations.png` を置き換える。

inventory の根拠のパスは、本リポジトリのファイルはリポジトリルートからの相対パス、他のリポジトリのファイルは `kmryst/<リポジトリ名>:<パス>` で書く。
