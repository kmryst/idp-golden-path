#!/usr/bin/env node

// セキュリティ起因の yarn resolutions の台帳検証と棚卸し。
//
// resolutions は期限付き例外と異なり「その行を外して依存解決し直せば、
// まだ必要かどうかを実測で判定できる」。そのため expires は持たせず、
// 台帳（scripts/ci/yarn-resolutions.json）と実測の 2 つで管理する。
//
// - sync モード（毎 PR）: 台帳のスキーマ検証と、backstage/package.json の
//   resolutions との双方向の同期検証。台帳エントリが package.json に無い、または
//   右辺が一致しない場合は fail する。逆に package.json の resolutions が
//   台帳にも非セキュリティ起因の宣言（scripts/ci/yarn-resolutions-non-security.json）
//   にも無い場合も fail する。片方向だけだと、セキュリティ起因の resolutions が
//   台帳未登録のまま週次 stale 棚卸しの対象外で残り続けるため（Issue #259）
// - stale モード（週次 / 手動）: 台帳の resolutions を全部外した一時プロジェクトで
//   lockfile を再解決（yarn install --mode=update-lockfile）して audit を実行し、
//   台帳に記録された advisory が再出現するかを実測する。
//   再出現しない resolution は不要になっているため fail し、削除を要求する
//
//   脆弱性以外の理由の resolutions（scripts/ci/yarn-resolutions-non-security.json）は
//   advisory を持たないため、`probe` を宣言したエントリだけを別の方法で実測する（Issue #291）。
//   行を外した一時プロジェクトで `yarn up -R <probe.up> --mode=update-lockfile` を実行し、
//   依存解決が通れば「解除可能」として撤去の差分を出力する（撤去 PR はワークフロー側が作る）。
//   行を残した同じ実行（対照）が通らない場合は、通信障害や台帳の誤りなど機構の故障として
//   fail し、「解除可能」とは区別する。素の yarn install では判定できない。
//   @yarnpkg/core/got の例では main の依存グラフに @yarnpkg/core 自体が無く、
//   行を外しても install が 1 秒で成功して誤って「解除可能」になるため（2026-10-03 実測）
//
// 正本: docs/operations/security-scanning.md
// （設計判断は ADR-0008 追記 2026-08-05、probe と撤去 PR は ADR-0015）

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { AuditPolicyError, escapeMarkdown } from "./npm-audit-policy.mjs";
import { parseYarnAuditOutput } from "./yarn-audit-policy.mjs";

const GHSA_PATTERN = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;
const RESOLUTION_PATTERN_FORMAT = /^(@?[a-z0-9][a-z0-9._/-]*)@npm:.+$/i;
const TRACKING_URL_FORMAT = /^https:\/\/\S+$/;
// probe.up は素のパッケージ名（scope 可）に限る。`yarn up -R` は glob も受け付けるが、
// 何にも一致しないパターンでも exit 0 になるため（2026-10-03 実測）、名前を固定して
// yarn.lock に実在するかを機構検査で確かめられるようにする
const PACKAGE_NAME_FORMAT = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

// 撤去 PR の本文に書く Issue 参照。PR Policy Check が `Refs #<n>` を必須とするため、
// 自動 PR では本機構を導入した Issue を参照する
const REMOVAL_PR_REFS_ISSUE = 291;
export const REMOVAL_PR_TITLE =
  "chore(deps): 不要になった yarn resolutions を撤去する";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REGISTRY_PATH = join(REPO_ROOT, "scripts", "ci", "yarn-resolutions.json");
const NON_SECURITY_PATH = join(
  REPO_ROOT,
  "scripts",
  "ci",
  "yarn-resolutions-non-security.json",
);
const PROJECT_DIR = join(REPO_ROOT, "backstage");

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseResolutionsRegistry(raw) {
  let parsed;

  try {
    parsed = JSON.parse(raw === undefined || raw.trim() === "" ? "[]" : raw);
  } catch (error) {
    throw new AuditPolicyError(
      `yarn-resolutions registry must be valid JSON: ${error.message}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new AuditPolicyError("yarn-resolutions registry must be a JSON array");
  }

  const seenPatterns = new Set();

  return parsed.map((entry, index) => {
    const label = `yarn-resolutions[${index}]`;
    if (!isRecord(entry)) {
      throw new AuditPolicyError(`${label} must be an object`);
    }

    const keys = Object.keys(entry).sort();
    const expectedKeys = ["advisories", "dependents", "pattern", "reason", "resolution"];
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key, keyIndex) => key !== expectedKeys[keyIndex])
    ) {
      throw new AuditPolicyError(
        `${label} must contain exactly pattern, resolution, advisories, dependents, and reason`,
      );
    }

    if (
      typeof entry.pattern !== "string" ||
      !RESOLUTION_PATTERN_FORMAT.test(entry.pattern)
    ) {
      throw new AuditPolicyError(
        `${label}.pattern must be a scoped resolutions key such as pkg@npm:<range>`,
      );
    }
    if (seenPatterns.has(entry.pattern)) {
      throw new AuditPolicyError(`${label}.pattern duplicates ${entry.pattern}`);
    }
    seenPatterns.add(entry.pattern);

    if (typeof entry.resolution !== "string" || entry.resolution.trim() === "") {
      throw new AuditPolicyError(`${label}.resolution must be a non-empty range`);
    }

    if (
      !Array.isArray(entry.advisories) ||
      entry.advisories.length === 0 ||
      entry.advisories.some(
        (advisory) => typeof advisory !== "string" || !GHSA_PATTERN.test(advisory),
      )
    ) {
      throw new AuditPolicyError(
        `${label}.advisories must be a non-empty array of canonical GHSA IDs`,
      );
    }
    if (new Set(entry.advisories).size !== entry.advisories.length) {
      throw new AuditPolicyError(`${label}.advisories contains duplicates`);
    }

    if (
      !Array.isArray(entry.dependents) ||
      entry.dependents.length === 0 ||
      entry.dependents.some(
        (dependent) => typeof dependent !== "string" || dependent.trim() === "",
      )
    ) {
      throw new AuditPolicyError(
        `${label}.dependents must be a non-empty array of package locators`,
      );
    }

    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      throw new AuditPolicyError(`${label}.reason must be a non-empty string`);
    }

    return {
      pattern: entry.pattern,
      resolution: entry.resolution,
      advisories: [...entry.advisories],
      dependents: [...entry.dependents],
      reason: entry.reason,
    };
  });
}

export function parseNonSecurityResolutions(raw) {
  let parsed;

  try {
    parsed = JSON.parse(raw === undefined || raw.trim() === "" ? "[]" : raw);
  } catch (error) {
    throw new AuditPolicyError(
      `yarn-resolutions-non-security must be valid JSON: ${error.message}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new AuditPolicyError(
      "yarn-resolutions-non-security must be a JSON array",
    );
  }

  const seenPatterns = new Set();

  return parsed.map((entry, index) => {
    const label = `yarn-resolutions-non-security[${index}]`;
    if (!isRecord(entry)) {
      throw new AuditPolicyError(`${label} must be an object`);
    }

    const keys = Object.keys(entry);
    const allowedKeys = new Set(["pattern", "reason", "probe", "tracking"]);
    const unknownKeys = keys.filter((key) => !allowedKeys.has(key));
    if (
      unknownKeys.length > 0 ||
      !keys.includes("pattern") ||
      !keys.includes("reason")
    ) {
      throw new AuditPolicyError(
        `${label} must contain pattern and reason, optionally probe and tracking`,
      );
    }

    if (typeof entry.pattern !== "string" || entry.pattern.trim() === "") {
      throw new AuditPolicyError(`${label}.pattern must be a non-empty string`);
    }
    if (seenPatterns.has(entry.pattern)) {
      throw new AuditPolicyError(`${label}.pattern duplicates ${entry.pattern}`);
    }
    seenPatterns.add(entry.pattern);

    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      throw new AuditPolicyError(`${label}.reason must be a non-empty string`);
    }

    const normalized = { pattern: entry.pattern, reason: entry.reason };

    // probe: 行を外した一時プロジェクトで `yarn up -R <up...> --mode=update-lockfile` を
    // 実行する宣言。`up` には、その resolutions が効く依存を引き込む親パッケージ
    // （例: @yarnpkg/core/got なら @backstage/cli）を書く
    if (keys.includes("probe")) {
      if (!isRecord(entry.probe)) {
        throw new AuditPolicyError(`${label}.probe must be an object with up`);
      }
      const probeKeys = Object.keys(entry.probe);
      if (probeKeys.length !== 1 || probeKeys[0] !== "up") {
        throw new AuditPolicyError(`${label}.probe must contain exactly up`);
      }
      if (
        !Array.isArray(entry.probe.up) ||
        entry.probe.up.length === 0 ||
        entry.probe.up.some(
          (target) =>
            typeof target !== "string" || !PACKAGE_NAME_FORMAT.test(target),
        )
      ) {
        throw new AuditPolicyError(
          `${label}.probe.up must be a non-empty array of package names (passed to yarn up -R)`,
        );
      }
      if (new Set(entry.probe.up).size !== entry.probe.up.length) {
        throw new AuditPolicyError(`${label}.probe.up contains duplicates`);
      }
      normalized.probe = { up: [...entry.probe.up] };
    }

    // tracking: 解除条件を追う Issue（上流または自リポジトリ）の URL
    if (keys.includes("tracking")) {
      if (
        typeof entry.tracking !== "string" ||
        !TRACKING_URL_FORMAT.test(entry.tracking)
      ) {
        throw new AuditPolicyError(`${label}.tracking must be an https URL`);
      }
      normalized.tracking = entry.tracking;
    }

    return normalized;
  });
}

// probe.up のパッケージが yarn.lock に npm 依存として実在するかの機構検査。
// `yarn up -R` は一致するパッケージが無くても exit 0 で終わるため、この検査が無いと
// 台帳の綴り間違いが対照・probe とも成功して「解除可能」の誤報になる
export function assertProbeTargetsInLockfile(entry, lockfileText) {
  for (const target of entry.probe.up) {
    const escaped = target.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    const descriptorKey = new RegExp(`(^"|, )${escaped}@npm:`, "m");
    if (!descriptorKey.test(lockfileText)) {
      throw new AuditPolicyError(
        `${entry.pattern}.probe.up names ${target}, which is not an npm dependency in backstage/yarn.lock; yarn up -R would match nothing and pass vacuously`,
      );
    }
  }
}

// probe の判定。対照（行を残した実行）が通らなければ、通信障害・台帳の誤り・
// 回避策自体の破綻のいずれかであり、probe の結果は信用できないので機構の故障として扱う
// （ADR-0013 の「MECHANISM を優先する」と同じ考え方）。
// 対照が通った上で、行を外した実行が通れば解除可能、通らなければまだ必要
export function classifyProbe(entry, controlStatus, probeStatus) {
  if (controlStatus !== 0) {
    throw new AuditPolicyError(
      `probe control run for ${entry.pattern} failed (yarn up -R ${entry.probe.up.join(" ")} with the resolution kept exited ${String(controlStatus)}); cannot tell whether the resolution is still needed`,
    );
  }
  return probeStatus === 0 ? "removable" : "needed";
}

// 解除可能と判定された resolutions を package.json と非セキュリティ宣言から外す（純粋関数）
export function applyRemoval(manifest, nonSecurity, removablePatterns) {
  const removable = new Set(removablePatterns);
  const resolutions = { ...(manifest.resolutions ?? {}) };
  for (const pattern of removable) {
    if (resolutions[pattern] === undefined) {
      throw new AuditPolicyError(
        `${pattern} is not present in package.json resolutions`,
      );
    }
    delete resolutions[pattern];
  }

  const nextManifest = { ...manifest };
  if (Object.keys(resolutions).length === 0) {
    delete nextManifest.resolutions;
  } else {
    nextManifest.resolutions = resolutions;
  }

  return {
    manifest: nextManifest,
    nonSecurity: nonSecurity.filter((entry) => !removable.has(entry.pattern)),
  };
}

export function renderProbeSummary(results, skipped) {
  const lines = [
    "## Yarn resolutions inventory (non-security probe)",
    "",
    `- Removable: ${results.filter((result) => result.outcome === "removable").length}`,
    `- Still needed: ${results.filter((result) => result.outcome === "needed").length}`,
    `- Not probed (no probe declared): ${skipped.length}`,
    "",
    "| Pattern | Probe (yarn up -R) | Tracking | Status |",
    "| --- | --- | --- | --- |",
  ];

  for (const result of results) {
    const status =
      result.outcome === "removable"
        ? "removable: removal pull request will be created"
        : "still needed";
    lines.push(
      `| ${escapeMarkdown(result.entry.pattern)} | ${escapeMarkdown(
        result.entry.probe.up.join(" "),
      )} | ${escapeMarkdown(result.entry.tracking ?? "-")} | ${status} |`,
    );
  }
  for (const entry of skipped) {
    lines.push(
      `| ${escapeMarkdown(entry.pattern)} | - | ${escapeMarkdown(
        entry.tracking ?? "-",
      )} | not probed |`,
    );
  }

  return `${lines.join("\n")}\n`;
}

// 撤去 PR の本文。PR テンプレート（.github/pull_request_template.md）の見出しに揃える
export function renderRemovalPullRequestBody(removable, options = {}) {
  const runUrl = options.runUrl ?? null;
  const lines = [
    "## 目的",
    "",
    "Yarn Resolutions Inventory の probe で、次の脆弱性以外の理由の yarn resolutions が不要になったことを実測した。",
    runUrl === null ? null : `probe を実行した run: ${runUrl}`,
    "",
    "| Pattern | Resolution | Probe (yarn up -R) | Tracking |",
    "| --- | --- | --- | --- |",
    ...removable.map(
      (item) =>
        `| \`${escapeMarkdown(item.entry.pattern)}\` | \`${escapeMarkdown(
          item.resolution,
        )}\` | \`${escapeMarkdown(item.entry.probe.up.join(" "))}\` | ${
          item.entry.tracking ?? "-"
        } |`,
    ),
    "",
    "## 変更内容",
    "",
    "- `backstage/package.json` の `resolutions` から上記の行を削除",
    "- `backstage/yarn.lock` を `yarn install --mode=update-lockfile` で再解決",
    "- `scripts/ci/yarn-resolutions-non-security.json` から上記のエントリを削除",
    "",
    "## 影響範囲",
    "",
    "- **対象**: `backstage/` の依存解決（上記 resolutions が効いていた依存のみ）",
    "- **非対象**: セキュリティ起因の resolutions（`scripts/ci/yarn-resolutions.json`）、Dependabot の更新 PR",
    "",
    "## 可観測性/検証",
    "",
    "- probe: 行を外した一時プロジェクトで `yarn up -R <Probe> --mode=update-lockfile` が exit 0",
    "- 対照: 行を残した同じ実行も exit 0（機構が健全であることの確認）",
    "- マージ前に Backstage CI（`yarn install --immutable` / `yarn tsc` / `yarn test`）が通ることを確認する",
    "",
    "## メモ（レビューポイント）",
    "",
    "- この PR は Dependency Audit ワークフローの Yarn Resolutions Inventory が自動作成した（正本: `docs/operations/security-scanning.md`、設計判断: ADR-0015）",
    "- 再実行しても同じブランチが更新され、PR は重複しない",
    "- 解除条件の判断材料は Tracking 列の Issue を参照する。上流の修正内容と一致しているか確認してからマージする",
    "",
    `Refs #${REMOVAL_PR_REFS_ISSUE}`,
  ];

  return `${lines.filter((line) => line !== null).join("\n")}\n`;
}

export function checkSync(registry, manifestResolutions, nonSecurity = []) {
  if (!isRecord(manifestResolutions)) {
    throw new AuditPolicyError(
      "backstage/package.json resolutions must be an object",
    );
  }

  const problems = [];

  const declaredPatterns = new Set([
    ...registry.map((entry) => entry.pattern),
    ...nonSecurity.map((entry) => entry.pattern),
  ]);

  const registryPatterns = new Set(registry.map((entry) => entry.pattern));

  // 台帳 -> package.json（従来からの片方向検証）
  for (const entry of registry) {
    const actual = manifestResolutions[entry.pattern];
    if (actual === undefined) {
      problems.push(
        `${entry.pattern} is registered in yarn-resolutions.json but missing from package.json resolutions`,
      );
    } else if (actual !== entry.resolution) {
      problems.push(
        `${entry.pattern} resolves to ${String(actual)} in package.json but ${entry.resolution} in yarn-resolutions.json`,
      );
    }
  }

  // 非セキュリティ起因の宣言 -> package.json（宣言だけが残るのを防ぐ）
  for (const entry of nonSecurity) {
    if (registryPatterns.has(entry.pattern)) {
      problems.push(
        `${entry.pattern} is declared in both yarn-resolutions.json and yarn-resolutions-non-security.json`,
      );
    }
    if (manifestResolutions[entry.pattern] === undefined) {
      problems.push(
        `${entry.pattern} is declared in yarn-resolutions-non-security.json but missing from package.json resolutions`,
      );
    }
  }

  // package.json -> 台帳 / 非セキュリティ宣言（未登録 resolutions の検出）
  for (const pattern of Object.keys(manifestResolutions)) {
    if (!declaredPatterns.has(pattern)) {
      problems.push(
        `${pattern} is present in package.json resolutions but declared in neither yarn-resolutions.json nor yarn-resolutions-non-security.json`,
      );
    }
  }

  return { pass: problems.length === 0, problems };
}

export function evaluateStaleness(registry, unpinnedAdvisories) {
  if (!Array.isArray(unpinnedAdvisories)) {
    throw new AuditPolicyError("unpinned advisories must be an array");
  }

  const reappearedGhsa = new Set(
    unpinnedAdvisories
      .map((advisory) => advisory.ghsa)
      .filter((ghsa) => typeof ghsa === "string"),
  );
  const recordedGhsa = new Set(
    registry.flatMap((entry) => entry.advisories),
  );
  const registryPackages = new Set(
    registry.map((entry) => entry.pattern.replace(/@npm:.*$/, "")),
  );

  const needed = [];
  const stale = [];

  for (const entry of registry) {
    const reappeared = entry.advisories.filter((advisory) =>
      reappearedGhsa.has(advisory),
    );
    if (reappeared.length > 0) {
      needed.push({ ...entry, reappeared });
    } else {
      stale.push(entry);
    }
  }

  // 管理対象パッケージに、台帳未記載の High / Critical が再出現した場合は
  // fail ではなく警告に留める（実グラフ側の週次 audit ゲートが本監視を担う）
  const unrecorded = unpinnedAdvisories.filter(
    (advisory) =>
      (advisory.severity === "high" || advisory.severity === "critical") &&
      registryPackages.has(advisory.package) &&
      (advisory.ghsa === null || !recordedGhsa.has(advisory.ghsa)),
  );

  return { pass: stale.length === 0, needed, stale, unrecorded };
}

export function renderResolutionsSummary(result) {
  const lines = [
    "## Yarn resolutions inventory (stale check)",
    "",
    `- Result: ${result.pass ? "passed" : "blocked (stale resolutions found)"}`,
    "",
    "| Pattern | Resolution | Advisories | Status |",
    "| --- | --- | --- | --- |",
  ];

  for (const entry of result.needed) {
    lines.push(
      `| ${escapeMarkdown(entry.pattern)} | ${escapeMarkdown(entry.resolution)} | ${escapeMarkdown(
        entry.reappeared.join(", "),
      )} | still needed |`,
    );
  }
  for (const entry of result.stale) {
    lines.push(
      `| ${escapeMarkdown(entry.pattern)} | ${escapeMarkdown(entry.resolution)} | ${escapeMarkdown(
        entry.advisories.join(", "),
      )} | stale: remove this resolution and its registry entry |`,
    );
  }

  if (result.unrecorded.length > 0) {
    lines.push(
      "",
      "> [!WARNING]",
      "> Unrecorded High / Critical advisories reappeared on managed packages:",
      "",
    );
    for (const advisory of result.unrecorded) {
      lines.push(
        `- ${escapeMarkdown(advisory.ghsa ?? `advisory:${advisory.advisoryId}`)} (${escapeMarkdown(
          advisory.severity,
        )}) on ${escapeMarkdown(advisory.package)}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function readRegistry() {
  if (!existsSync(REGISTRY_PATH)) {
    return [];
  }
  return parseResolutionsRegistry(readFileSync(REGISTRY_PATH, "utf8"));
}

function readNonSecurityResolutions() {
  if (!existsSync(NON_SECURITY_PATH)) {
    return [];
  }
  return parseNonSecurityResolutions(readFileSync(NON_SECURITY_PATH, "utf8"));
}

function readManifest() {
  const manifest = JSON.parse(readFileSync(join(PROJECT_DIR, "package.json"), "utf8"));
  if (!isRecord(manifest)) {
    throw new AuditPolicyError("backstage/package.json must be a JSON object");
  }
  return manifest;
}

function runSync() {
  const registry = readRegistry();
  const nonSecurity = readNonSecurityResolutions();
  const manifest = readManifest();
  const result = checkSync(registry, manifest.resolutions ?? {}, nonSecurity);

  if (!result.pass) {
    for (const problem of result.problems) {
      process.stderr.write(`::error::${problem}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `yarn-resolutions.json is in sync with package.json (${registry.length} managed resolutions, ${nonSecurity.length} declared non-security resolutions)\n`,
  );
}

function copyWorkspaceManifests(manifest, targetDir) {
  const workspaceGlobs = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : [];

  for (const glob of workspaceGlobs) {
    if (typeof glob !== "string" || !glob.endsWith("/*")) {
      throw new AuditPolicyError(
        `Unsupported workspace glob for the stale check: ${String(glob)}`,
      );
    }
    const baseDir = glob.slice(0, -2);
    const sourceBase = join(PROJECT_DIR, baseDir);
    if (!existsSync(sourceBase)) {
      continue;
    }
    for (const dirent of readdirSync(sourceBase, { withFileTypes: true })) {
      if (!dirent.isDirectory()) {
        continue;
      }
      const manifestPath = join(sourceBase, dirent.name, "package.json");
      if (existsSync(manifestPath)) {
        cpSync(
          manifestPath,
          join(targetDir, baseDir, dirent.name, "package.json"),
        );
      }
    }
  }
}

// manifest（resolutions を加工済みの backstage/package.json 相当）から、依存解決だけが
// できる一時プロジェクトを作る。yarn.lock / .yarnrc.yml / Yarn 本体 / workspace の
// package.json を複製し、作業ツリーは汚さない
function buildTempProject(manifest, prefix) {
  const tempDir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(
    join(tempDir, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  cpSync(join(PROJECT_DIR, "yarn.lock"), join(tempDir, "yarn.lock"));

  const yarnrcPath = join(PROJECT_DIR, ".yarnrc.yml");
  if (existsSync(yarnrcPath)) {
    cpSync(yarnrcPath, join(tempDir, ".yarnrc.yml"));
    const yarnPathMatch = readFileSync(yarnrcPath, "utf8").match(
      /^yarnPath:\s*(\S+)\s*$/m,
    );
    if (yarnPathMatch !== null) {
      cpSync(
        join(PROJECT_DIR, yarnPathMatch[1]),
        join(tempDir, yarnPathMatch[1]),
      );
    }
  }

  copyWorkspaceManifests(manifest, tempDir);
  return tempDir;
}

function withoutResolutions(manifest, patterns) {
  const resolutions = { ...(manifest.resolutions ?? {}) };
  for (const pattern of patterns) {
    delete resolutions[pattern];
  }
  return { ...manifest, resolutions };
}

function buildUnpinnedProject(registry) {
  return buildTempProject(
    withoutResolutions(
      readManifest(),
      registry.map((entry) => entry.pattern),
    ),
    "yarn-resolutions-stale-",
  );
}

// Yarn は失敗理由を stdout の `➤ YN0001: │ Error: ...` 行に書き、致命的エラーでは
// その後にバンドル済みソースのスタックトレースを吐く。末尾を切り出すとトレースだけが
// 残って原因が読めないため（run 37107421095 で実測）、報告行を優先して抜き出す
export function summarizeYarnFailure(stdout, stderr) {
  const reportLines = `${stdout}\n${stderr}`
    .split("\n")
    .filter((line) => /YN\d{4}:|Error:|error/i.test(line) && !/^\s*at /.test(line))
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(0, 10);
  if (reportLines.length > 0) {
    return reportLines.join(" | ").slice(0, 2000);
  }
  return `${stdout}${stderr}`.trim().slice(-1000);
}

function runYarn(args, cwd) {
  const result = spawnSync("yarn", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });

  if (result.error !== undefined) {
    throw new AuditPolicyError(`Failed to execute yarn: ${result.error.message}`);
  }
  if (result.signal !== null) {
    throw new AuditPolicyError(`yarn was terminated by signal ${result.signal}`);
  }

  return result;
}

function appendSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (typeof summaryPath === "string" && summaryPath !== "") {
    appendFileSync(summaryPath, markdown, "utf8");
  }
}

function writeGitHubOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (typeof outputPath === "string" && outputPath !== "") {
    appendFileSync(outputPath, `${name}=${value}\n`, "utf8");
  }
}

function runSecurityStale(registry) {
  if (registry.length === 0) {
    process.stdout.write("No managed yarn resolutions to check\n");
    return true;
  }

  const tempDir = buildUnpinnedProject(registry);
  try {
    const install = runYarn(["install", "--mode=update-lockfile"], tempDir);
    if (install.status !== 0) {
      throw new AuditPolicyError(
        `yarn install --mode=update-lockfile failed with status ${String(install.status)}: ${summarizeYarnFailure(install.stdout, install.stderr)}`,
      );
    }

    const audit = runYarn(
      ["npm", "audit", "--all", "--recursive", "--json"],
      tempDir,
    );
    if (audit.status !== 0 && audit.status !== 1) {
      throw new AuditPolicyError(
        `yarn npm audit exited with unexpected status ${String(audit.status)}`,
      );
    }

    const advisories = parseYarnAuditOutput(audit.stdout);
    if (audit.status === 1 && advisories.length === 0) {
      throw new AuditPolicyError(
        "yarn npm audit exited with status 1 without reporting advisories",
      );
    }

    const result = evaluateStaleness(registry, advisories);
    const summary = renderResolutionsSummary(result);
    appendSummary(summary);
    process.stdout.write(summary);
    return result.pass;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// probe 1 件 = 一時プロジェクト 2 つ（対照: 行を残す / probe: 行を外す）で
// `yarn up -R <up...> --mode=update-lockfile` を実行する。
// 対照を先に実行し、通らなければ probe は実行せず機構の故障として fail する
function runProbe(manifest, entry) {
  const args = ["up", "-R", ...entry.probe.up, "--mode=update-lockfile"];

  const controlDir = buildTempProject(manifest, "yarn-resolutions-control-");
  let controlStatus;
  try {
    const control = runYarn(args, controlDir);
    controlStatus = control.status;
    if (controlStatus !== 0) {
      process.stderr.write(
        `${summarizeYarnFailure(control.stdout, control.stderr)}\n`,
      );
    }
  } finally {
    rmSync(controlDir, { recursive: true, force: true });
  }
  if (controlStatus !== 0) {
    return classifyProbe(entry, controlStatus, null);
  }

  const probeDir = buildTempProject(
    withoutResolutions(manifest, [entry.pattern]),
    "yarn-resolutions-probe-",
  );
  try {
    const probe = runYarn(args, probeDir);
    process.stdout.write(
      `probe ${entry.pattern}: yarn ${args.join(" ")} exited ${String(probe.status)}\n`,
    );
    return classifyProbe(entry, controlStatus, probe.status);
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

// 解除可能な resolutions を外した package.json で lockfile を再解決し、
// 撤去 PR の差分（backstage/package.json・backstage/yarn.lock・非セキュリティ宣言・PR 本文）
// を outputDir に書き出す。lockfile の再解決が通らない場合は機構の故障として fail する
function writeRemoval(manifest, nonSecurity, removable, outputDir) {
  const removed = applyRemoval(
    manifest,
    nonSecurity,
    removable.map((item) => item.entry.pattern),
  );

  const tempDir = buildTempProject(removed.manifest, "yarn-resolutions-removal-");
  try {
    const install = runYarn(["install", "--mode=update-lockfile"], tempDir);
    if (install.status !== 0) {
      throw new AuditPolicyError(
        `yarn install --mode=update-lockfile without the removable resolutions failed with status ${String(install.status)}: ${summarizeYarnFailure(install.stdout, install.stderr)}`,
      );
    }

    mkdirSync(join(outputDir, "backstage"), { recursive: true });
    mkdirSync(join(outputDir, "scripts", "ci"), { recursive: true });
    writeFileSync(
      join(outputDir, "backstage", "package.json"),
      `${JSON.stringify(removed.manifest, null, 2)}\n`,
      "utf8",
    );
    cpSync(join(tempDir, "yarn.lock"), join(outputDir, "backstage", "yarn.lock"));
    writeFileSync(
      join(outputDir, "scripts", "ci", "yarn-resolutions-non-security.json"),
      `${JSON.stringify(removed.nonSecurity, null, 2)}\n`,
      "utf8",
    );

    const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
    const runUrl =
      GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
        ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
        : null;
    writeFileSync(
      join(outputDir, "pull-request-body.md"),
      renderRemovalPullRequestBody(removable, { runUrl }),
      "utf8",
    );
    writeFileSync(
      join(outputDir, "pull-request-title.txt"),
      `${REMOVAL_PR_TITLE}\n`,
      "utf8",
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function runNonSecurityProbes(manifest, nonSecurity) {
  const probed = nonSecurity.filter((entry) => entry.probe !== undefined);
  const skipped = nonSecurity.filter((entry) => entry.probe === undefined);

  // 機構検査は全 probe の前に済ませる。1 件でも台帳が壊れていれば probe を実行しない
  const lockfileText = readFileSync(join(PROJECT_DIR, "yarn.lock"), "utf8");
  for (const entry of probed) {
    assertProbeTargetsInLockfile(entry, lockfileText);
  }

  const results = probed.map((entry) => ({
    entry,
    resolution: manifest.resolutions[entry.pattern],
    outcome: runProbe(manifest, entry),
  }));

  const summary = renderProbeSummary(results, skipped);
  appendSummary(summary);
  process.stdout.write(summary);

  const removable = results.filter((result) => result.outcome === "removable");
  const outputDir = process.env.IDP_RESOLUTIONS_REMOVAL_DIR;
  if (
    removable.length > 0 &&
    typeof outputDir === "string" &&
    outputDir !== ""
  ) {
    writeRemoval(manifest, nonSecurity, removable, outputDir);
    process.stdout.write(`removal files written to ${outputDir}\n`);
  }
  writeGitHubOutput("removal", removable.length > 0 ? "true" : "false");
}

function runStale() {
  const registry = readRegistry();
  const nonSecurity = readNonSecurityResolutions();
  const manifest = readManifest();
  const sync = checkSync(registry, manifest.resolutions ?? {}, nonSecurity);
  if (!sync.pass) {
    throw new AuditPolicyError(
      `yarn-resolutions.json is out of sync: ${sync.problems.join("; ")}`,
    );
  }

  const securityPass = runSecurityStale(registry);
  runNonSecurityProbes(manifest, nonSecurity);

  if (!securityPass) {
    process.exitCode = 1;
  }
}

async function main() {
  const mode = process.argv[2];

  try {
    if (mode === "sync") {
      runSync();
    } else if (mode === "stale") {
      runStale();
    } else {
      throw new AuditPolicyError(
        `Usage: yarn-resolutions-audit.mjs <sync|stale> (got ${String(mode)})`,
      );
    }
  } catch (error) {
    const policyError =
      error instanceof AuditPolicyError
        ? error
        : new AuditPolicyError(`Unexpected inventory error: ${error.message}`);
    process.stderr.write(`::error::${policyError.message}\n`);
    process.exitCode = 1;
  }
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedAsScript) {
  await main();
}
