// 撤去 PR の自動作成で、probe job（secret なし）と PR 作成 job（GitHub App トークンあり）の
// 間を渡る artifact の扱いを共通化する部品。
//
// 信頼境界は artifact の境界に置く（ADR-0015 選択肢 8）。probe job は未検証の上流コードを
// 実行しうるため、PR 作成 job は artifact から removal.json 1 ファイルだけを受け取り、
// その中身（外す対象の識別子）を信頼できる checkout の台帳で許可リスト照合してから、
// 差分と PR 本文を自分で生成する。このモジュールはそのうち「artifact に removal.json
// 以外のファイルが無いこと」の検査と読み込み、PR 本文に書く run URL の組み立てを担う。
// removal.json のスキーマ検証と許可リスト照合は、対象ごとの評価器が持つ。
//
// 利用者: scripts/ci/yarn-resolutions-audit.mjs（ADR-0015）、
//         scripts/ci/dependabot-unblock-check.mjs（Issue #310）
// 外部依存ゼロ・ネットワークなし・コマンド実行なし。

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const REMOVAL_REQUEST_FILENAME = "removal.json";

// artifact に removal.json 以外のファイルがあれば、probe job が差分や本文を
// 持ち込もうとしているとみなして拒否する。ErrorClass は呼び出し側の評価器のエラー型
export function assertRemovalArtifactFiles(files, ErrorClass = Error) {
  const sorted = [...files].sort();
  if (sorted.length !== 1 || sorted[0] !== REMOVAL_REQUEST_FILENAME) {
    throw new ErrorClass(
      `removal artifact must contain only ${REMOVAL_REQUEST_FILENAME} (found: ${
        sorted.length === 0 ? "nothing" : sorted.join(", ")
      })`,
    );
  }
}

// artifact を展開したディレクトリを再帰的に列挙し、removal.json 1 ファイルだけで
// あることを確かめてから、その中身（未検証の文字列）を返す
export function readRemovalRequestFile(requestDir, ErrorClass = Error) {
  assertRemovalArtifactFiles(
    readdirSync(requestDir, { recursive: true, withFileTypes: true })
      .filter((dirent) => !dirent.isDirectory())
      .map((dirent) => dirent.name),
    ErrorClass,
  );
  return readFileSync(join(requestDir, REMOVAL_REQUEST_FILENAME), "utf8");
}

// PR 本文に載せる「probe を実行した run」の URL。GitHub Actions の外では null
export function workflowRunUrl(env = process.env) {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = env;
  return GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
    ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
    : null;
}
