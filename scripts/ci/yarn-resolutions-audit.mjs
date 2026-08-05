#!/usr/bin/env node

// セキュリティ起因の yarn resolutions の台帳検証と棚卸し。
//
// resolutions は期限付き例外と異なり「その行を外して依存解決し直せば、
// まだ必要かどうかを実測で判定できる」。そのため expires は持たせず、
// 台帳（scripts/ci/yarn-resolutions.json）と実測の 2 つで管理する。
//
// - sync モード（毎 PR）: 台帳のスキーマ検証と、backstage/package.json の
//   resolutions との同期検証。台帳エントリが package.json に無い、または
//   右辺が一致しない場合は fail する
// - stale モード（週次 / 手動）: 台帳の resolutions を全部外した一時プロジェクトで
//   lockfile を再解決（yarn install --mode=update-lockfile）して audit を実行し、
//   台帳に記録された advisory が再出現するかを実測する。
//   再出現しない resolution は不要になっているため fail し、削除を要求する
//
// 正本: docs/operations/security-scanning.md（設計判断は ADR-0008 追記 2026-08-05）

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
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

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REGISTRY_PATH = join(REPO_ROOT, "scripts", "ci", "yarn-resolutions.json");
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

export function checkSync(registry, manifestResolutions) {
  if (!isRecord(manifestResolutions)) {
    throw new AuditPolicyError(
      "backstage/package.json resolutions must be an object",
    );
  }

  const problems = [];

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

function readManifest() {
  const manifest = JSON.parse(readFileSync(join(PROJECT_DIR, "package.json"), "utf8"));
  if (!isRecord(manifest)) {
    throw new AuditPolicyError("backstage/package.json must be a JSON object");
  }
  return manifest;
}

function runSync() {
  const registry = readRegistry();
  const manifest = readManifest();
  const result = checkSync(registry, manifest.resolutions ?? {});

  if (!result.pass) {
    for (const problem of result.problems) {
      process.stderr.write(`::error::${problem}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `yarn-resolutions.json is in sync with package.json (${registry.length} managed resolutions)\n`,
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

function buildUnpinnedProject(registry) {
  const manifest = readManifest();
  const resolutions = { ...(manifest.resolutions ?? {}) };
  for (const entry of registry) {
    delete resolutions[entry.pattern];
  }

  const tempDir = mkdtempSync(join(tmpdir(), "yarn-resolutions-stale-"));
  writeFileSync(
    join(tempDir, "package.json"),
    `${JSON.stringify({ ...manifest, resolutions }, null, 2)}\n`,
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

function runStale() {
  const registry = readRegistry();
  const manifest = readManifest();
  const sync = checkSync(registry, manifest.resolutions ?? {});
  if (!sync.pass) {
    throw new AuditPolicyError(
      `yarn-resolutions.json is out of sync: ${sync.problems.join("; ")}`,
    );
  }

  if (registry.length === 0) {
    process.stdout.write("No managed yarn resolutions to check\n");
    return;
  }

  const tempDir = buildUnpinnedProject(registry);
  try {
    const install = runYarn(["install", "--mode=update-lockfile"], tempDir);
    if (install.status !== 0) {
      throw new AuditPolicyError(
        `yarn install --mode=update-lockfile failed with status ${String(install.status)}: ${install.stderr.slice(0, 2000)}`,
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

    if (!result.pass) {
      process.exitCode = 1;
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
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
