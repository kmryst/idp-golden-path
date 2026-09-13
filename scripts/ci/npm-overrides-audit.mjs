#!/usr/bin/env node

// セキュリティ起因の npm overrides の台帳検証と棚卸し。
//
// yarn 側（scripts/ci/yarn-resolutions-audit.mjs）と同じ考え方を npm に移植したもので、
// overrides は期限付き例外と異なり「その行を外して依存解決し直せば、まだ必要かどうかを
// 実測で判定できる」ため expires は持たせず、台帳と実測の 2 つで管理する。
//
// - sync モード（毎 PR）: 台帳のスキーマ検証と、各 package.json の overrides との
//   双方向の同期検証。台帳エントリが package.json に無い、右辺が一致しない、
//   どちらの宣言にも無い overrides がある、のいずれでも fail する
// - stale モード（週次 / 手動）: 台帳の overrides を外した一時プロジェクトで lockfile を
//   再解決（npm install --package-lock-only、作業ツリーは汚さない）して audit を実行し、
//   台帳に記録された advisory が再出現するかを実測する。
//   再出現しない overrides は不要になっているため fail し、削除を要求する
//
// yarn 側と違い、対象ディレクトリがルートと skeleton の 2 箇所ある。台帳は 1 ファイルにまとめ、
// エントリ側が `directories` で適用先を宣言する。ルートと skeleton は同じ devDependencies を
// 持ち「両方に同じ overrides を入れる」ことが運用上の不変条件なので、台帳をディレクトリごとに
// 分けると同じエントリを 2 回書くことになり、sync が防ごうとしている乖離を台帳自身が抱え込む。
//
// 正本: docs/operations/security-scanning.md

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  AuditPolicyError,
  NPM_FULL_AUDIT_ARGS,
  canonicalGhsaFromAdvisoryUrl,
  escapeMarkdown,
  parseAuditJson,
} from "./npm-audit-policy.mjs";

const GHSA_PATTERN = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;
// npm の overrides キーはパッケージ名そのもの（yarn の `pkg@npm:<range>` のような
// range 付きキーは npm では親セレクタの書式であり、上書き対象の指定には使わない）
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

const SEVERITY_RANK = new Map([
  ["info", 0],
  ["low", 1],
  ["moderate", 2],
  ["high", 3],
  ["critical", 4],
]);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REGISTRY_PATH = join(REPO_ROOT, "scripts", "ci", "npm-overrides.json");
const NON_SECURITY_PATH = join(
  REPO_ROOT,
  "scripts",
  "ci",
  "npm-overrides-non-security.json",
);

// 監査対象の npm プロジェクト。dependency-audit.yml の npm-dependency-audit job の
// matrix と同じ集合であり、npm プロジェクトを増やすときは両方を更新する
export const NPM_PROJECT_DIRECTORIES = Object.freeze([
  ".",
  "backstage/templates/service-baseline/skeleton",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseDirectories(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AuditPolicyError(
      `${label}.directories must be a non-empty array of npm project directories`,
    );
  }
  if (new Set(value).size !== value.length) {
    throw new AuditPolicyError(`${label}.directories contains duplicates`);
  }
  for (const directory of value) {
    if (!NPM_PROJECT_DIRECTORIES.includes(directory)) {
      throw new AuditPolicyError(
        `${label}.directories contains an unknown npm project directory: ${String(directory)}`,
      );
    }
  }
  return [...value];
}

export function parseOverridesRegistry(raw) {
  let parsed;

  try {
    parsed = JSON.parse(raw === undefined || raw.trim() === "" ? "[]" : raw);
  } catch (error) {
    throw new AuditPolicyError(
      `npm-overrides registry must be valid JSON: ${error.message}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new AuditPolicyError("npm-overrides registry must be a JSON array");
  }

  const seenPatterns = new Set();

  return parsed.map((entry, index) => {
    const label = `npm-overrides[${index}]`;
    if (!isRecord(entry)) {
      throw new AuditPolicyError(`${label} must be an object`);
    }

    const keys = Object.keys(entry).sort();
    const expectedKeys = [
      "advisories",
      "dependents",
      "directories",
      "override",
      "pattern",
      "reason",
    ];
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key, keyIndex) => key !== expectedKeys[keyIndex])
    ) {
      throw new AuditPolicyError(
        `${label} must contain exactly pattern, override, directories, advisories, dependents, and reason`,
      );
    }

    if (
      typeof entry.pattern !== "string" ||
      !PACKAGE_NAME_PATTERN.test(entry.pattern)
    ) {
      throw new AuditPolicyError(
        `${label}.pattern must be an npm package name such as smol-toml or @scope/name`,
      );
    }
    if (seenPatterns.has(entry.pattern)) {
      throw new AuditPolicyError(`${label}.pattern duplicates ${entry.pattern}`);
    }
    seenPatterns.add(entry.pattern);

    if (typeof entry.override !== "string" || entry.override.trim() === "") {
      throw new AuditPolicyError(`${label}.override must be a non-empty range`);
    }

    const directories = parseDirectories(entry.directories, label);

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
      override: entry.override,
      directories,
      advisories: [...entry.advisories],
      dependents: [...entry.dependents],
      reason: entry.reason,
    };
  });
}

export function parseNonSecurityOverrides(raw) {
  let parsed;

  try {
    parsed = JSON.parse(raw === undefined || raw.trim() === "" ? "[]" : raw);
  } catch (error) {
    throw new AuditPolicyError(
      `npm-overrides-non-security must be valid JSON: ${error.message}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new AuditPolicyError(
      "npm-overrides-non-security must be a JSON array",
    );
  }

  const seenPatterns = new Set();

  return parsed.map((entry, index) => {
    const label = `npm-overrides-non-security[${index}]`;
    if (!isRecord(entry)) {
      throw new AuditPolicyError(`${label} must be an object`);
    }

    const keys = Object.keys(entry).sort();
    const expectedKeys = ["directories", "pattern", "reason"];
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key, keyIndex) => key !== expectedKeys[keyIndex])
    ) {
      throw new AuditPolicyError(
        `${label} must contain exactly pattern, directories, and reason`,
      );
    }

    if (typeof entry.pattern !== "string" || entry.pattern.trim() === "") {
      throw new AuditPolicyError(`${label}.pattern must be a non-empty string`);
    }
    if (seenPatterns.has(entry.pattern)) {
      throw new AuditPolicyError(`${label}.pattern duplicates ${entry.pattern}`);
    }
    seenPatterns.add(entry.pattern);

    const directories = parseDirectories(entry.directories, label);

    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      throw new AuditPolicyError(`${label}.reason must be a non-empty string`);
    }

    return { pattern: entry.pattern, directories, reason: entry.reason };
  });
}

export function checkSync(registry, overridesByDirectory, nonSecurity = []) {
  if (!isRecord(overridesByDirectory)) {
    throw new AuditPolicyError(
      "npm overrides must be given as a directory-keyed object",
    );
  }

  const problems = [];

  for (const [directory, overrides] of Object.entries(overridesByDirectory)) {
    if (!isRecord(overrides)) {
      throw new AuditPolicyError(
        `${directory}/package.json overrides must be an object`,
      );
    }

    const registryForDirectory = registry.filter((entry) =>
      entry.directories.includes(directory),
    );
    const nonSecurityForDirectory = nonSecurity.filter((entry) =>
      entry.directories.includes(directory),
    );
    const registryPatterns = new Set(
      registryForDirectory.map((entry) => entry.pattern),
    );
    const declaredPatterns = new Set([
      ...registryPatterns,
      ...nonSecurityForDirectory.map((entry) => entry.pattern),
    ]);

    // 台帳 -> package.json
    for (const entry of registryForDirectory) {
      const actual = overrides[entry.pattern];
      if (actual === undefined) {
        problems.push(
          `${directory}: ${entry.pattern} is registered in npm-overrides.json but missing from package.json overrides`,
        );
      } else if (actual !== entry.override) {
        problems.push(
          `${directory}: ${entry.pattern} overrides to ${String(actual)} in package.json but ${entry.override} in npm-overrides.json`,
        );
      }
    }

    // 非セキュリティ起因の宣言 -> package.json（宣言だけが残るのを防ぐ）
    for (const entry of nonSecurityForDirectory) {
      if (registryPatterns.has(entry.pattern)) {
        problems.push(
          `${directory}: ${entry.pattern} is declared in both npm-overrides.json and npm-overrides-non-security.json`,
        );
      }
      if (overrides[entry.pattern] === undefined) {
        problems.push(
          `${directory}: ${entry.pattern} is declared in npm-overrides-non-security.json but missing from package.json overrides`,
        );
      }
    }

    // package.json -> 台帳 / 非セキュリティ宣言（未登録 overrides の検出）
    for (const [pattern, value] of Object.entries(overrides)) {
      if (!declaredPatterns.has(pattern)) {
        problems.push(
          `${directory}: ${pattern} is present in package.json overrides but declared in neither npm-overrides.json nor npm-overrides-non-security.json`,
        );
        continue;
      }
      // ネストした overrides（オブジェクト右辺）は台帳が右辺を 1 つの range として
      // 照合できず、stale の「その行を外して再解決する」判定も成り立たないため許可しない
      if (typeof value !== "string") {
        problems.push(
          `${directory}: ${pattern} must use a string override; nested override objects are not supported`,
        );
      }
    }
  }

  return { pass: problems.length === 0, problems };
}

function normalizeSeverity(value, label) {
  if (typeof value !== "string" || !SEVERITY_RANK.has(value.toLowerCase())) {
    throw new AuditPolicyError(`${label} has an unknown severity: ${String(value)}`);
  }
  return value.toLowerCase();
}

// npm audit --json の vulnerabilities から、severity を問わず advisory を取り出す。
// npm-audit-policy.mjs の evaluateAuditReport は High / Critical だけを見るゲート用で、
// 棚卸しでは「台帳の advisory が再出現したか」を severity に関係なく判定する必要がある
export function extractAdvisories(reportValue) {
  if (!isRecord(reportValue) || !isRecord(reportValue.vulnerabilities)) {
    throw new AuditPolicyError("npm audit output is missing vulnerabilities");
  }

  const advisoryByKey = new Map();

  for (const [packageName, vulnerability] of Object.entries(
    reportValue.vulnerabilities,
  )) {
    if (!isRecord(vulnerability) || !Array.isArray(vulnerability.via)) {
      throw new AuditPolicyError(
        `npm audit vulnerability entry for ${packageName} must contain a via array`,
      );
    }

    for (const via of vulnerability.via) {
      if (typeof via === "string") {
        continue;
      }
      if (!isRecord(via)) {
        throw new AuditPolicyError(
          `npm audit via entry for ${packageName} has an unsupported type`,
        );
      }

      const advisory = {
        package: typeof via.name === "string" ? via.name : packageName,
        ghsa: canonicalGhsaFromAdvisoryUrl(via.url),
        severity: normalizeSeverity(
          via.severity,
          `npm audit root advisory for ${packageName}`,
        ),
        title:
          typeof via.title === "string" && via.title.trim() !== ""
            ? via.title.trim()
            : "Untitled advisory",
      };
      const key = `${advisory.package} ${advisory.ghsa ?? advisory.title}`;
      if (!advisoryByKey.has(key)) {
        advisoryByKey.set(key, advisory);
      }
    }
  }

  return [...advisoryByKey.values()];
}

export function evaluateStaleness(registry, advisoriesByDirectory) {
  if (!isRecord(advisoriesByDirectory)) {
    throw new AuditPolicyError(
      "unpinned advisories must be given as a directory-keyed object",
    );
  }

  const needed = [];
  const stale = [];
  const unrecorded = [];

  for (const [directory, advisories] of Object.entries(advisoriesByDirectory)) {
    if (!Array.isArray(advisories)) {
      throw new AuditPolicyError(
        `unpinned advisories for ${directory} must be an array`,
      );
    }

    const registryForDirectory = registry.filter((entry) =>
      entry.directories.includes(directory),
    );
    const reappearedGhsa = new Set(
      advisories
        .map((advisory) => advisory.ghsa)
        .filter((ghsa) => typeof ghsa === "string"),
    );
    const recordedGhsa = new Set(
      registryForDirectory.flatMap((entry) => entry.advisories),
    );
    const managedPackages = new Set(
      registryForDirectory.map((entry) => entry.pattern),
    );

    for (const entry of registryForDirectory) {
      const reappeared = entry.advisories.filter((advisory) =>
        reappearedGhsa.has(advisory),
      );
      if (reappeared.length > 0) {
        needed.push({ ...entry, directory, reappeared });
      } else {
        stale.push({ ...entry, directory });
      }
    }

    // 管理対象パッケージに台帳未記載の High / Critical が再出現した場合は fail ではなく
    // 警告に留める（実グラフ側の audit ゲート npm Dependency Audit が本監視を担う）
    for (const advisory of advisories) {
      if (
        (advisory.severity === "high" || advisory.severity === "critical") &&
        managedPackages.has(advisory.package) &&
        (advisory.ghsa === null || !recordedGhsa.has(advisory.ghsa))
      ) {
        unrecorded.push({ ...advisory, directory });
      }
    }
  }

  return { pass: stale.length === 0, needed, stale, unrecorded };
}

export function renderOverridesSummary(result) {
  const lines = [
    "## npm overrides inventory (stale check)",
    "",
    `- Result: ${result.pass ? "passed" : "blocked (stale overrides found)"}`,
    "",
    "| Directory | Pattern | Override | Advisories | Status |",
    "| --- | --- | --- | --- | --- |",
  ];

  for (const entry of result.needed) {
    lines.push(
      `| ${escapeMarkdown(entry.directory)} | ${escapeMarkdown(entry.pattern)} | ${escapeMarkdown(
        entry.override,
      )} | ${escapeMarkdown(entry.reappeared.join(", "))} | still needed |`,
    );
  }
  for (const entry of result.stale) {
    lines.push(
      `| ${escapeMarkdown(entry.directory)} | ${escapeMarkdown(entry.pattern)} | ${escapeMarkdown(
        entry.override,
      )} | ${escapeMarkdown(entry.advisories.join(", "))} | stale: remove this override and its registry entry |`,
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
        `- ${escapeMarkdown(advisory.ghsa ?? advisory.title)} (${escapeMarkdown(
          advisory.severity,
        )}) on ${escapeMarkdown(advisory.package)} in ${escapeMarkdown(
          advisory.directory,
        )}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function readRegistry() {
  if (!existsSync(REGISTRY_PATH)) {
    return [];
  }
  return parseOverridesRegistry(readFileSync(REGISTRY_PATH, "utf8"));
}

// 非セキュリティ起因の npm overrides は現時点で 1 件も無いため、宣言ファイル自体を置いていない。
// 追加が必要になったら scripts/ci/npm-overrides-non-security.json を作れば、この経路が拾う
function readNonSecurityOverrides() {
  if (!existsSync(NON_SECURITY_PATH)) {
    return [];
  }
  return parseNonSecurityOverrides(readFileSync(NON_SECURITY_PATH, "utf8"));
}

function readManifest(directory) {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, directory, "package.json"), "utf8"),
  );
  if (!isRecord(manifest)) {
    throw new AuditPolicyError(`${directory}/package.json must be a JSON object`);
  }
  return manifest;
}

function readOverridesByDirectory() {
  const overridesByDirectory = {};
  for (const directory of NPM_PROJECT_DIRECTORIES) {
    overridesByDirectory[directory] = readManifest(directory).overrides ?? {};
  }
  return overridesByDirectory;
}

function runSync() {
  const registry = readRegistry();
  const nonSecurity = readNonSecurityOverrides();
  const result = checkSync(registry, readOverridesByDirectory(), nonSecurity);

  if (!result.pass) {
    for (const problem of result.problems) {
      process.stderr.write(`::error::${problem}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `npm-overrides.json is in sync with ${NPM_PROJECT_DIRECTORIES.length} package.json files (${registry.length} managed overrides, ${nonSecurity.length} declared non-security overrides)\n`,
  );
}

function runNpm(args, cwd) {
  const result = spawnSync("npm", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });

  if (result.error !== undefined) {
    throw new AuditPolicyError(`Failed to execute npm: ${result.error.message}`);
  }
  if (result.signal !== null) {
    throw new AuditPolicyError(`npm was terminated by signal ${result.signal}`);
  }

  return result;
}

function buildUnpinnedProject(directory, registryForDirectory) {
  const manifest = readManifest(directory);
  const overrides = { ...(manifest.overrides ?? {}) };
  for (const entry of registryForDirectory) {
    delete overrides[entry.pattern];
  }

  const nextManifest = { ...manifest };
  if (Object.keys(overrides).length === 0) {
    delete nextManifest.overrides;
  } else {
    nextManifest.overrides = overrides;
  }

  const tempDir = mkdtempSync(join(tmpdir(), "npm-overrides-stale-"));
  writeFileSync(
    join(tempDir, "package.json"),
    `${JSON.stringify(nextManifest, null, 2)}\n`,
    "utf8",
  );
  cpSync(
    join(REPO_ROOT, directory, "package-lock.json"),
    join(tempDir, "package-lock.json"),
  );
  return tempDir;
}

function measureUnpinnedAdvisories(directory, registryForDirectory) {
  const tempDir = buildUnpinnedProject(directory, registryForDirectory);
  try {
    // --ignore-scripts: 一時プロジェクトで依存の lifecycle script を走らせない
    // （lockfile の再解決だけが目的で、node_modules も作らない）
    const install = runNpm(
      ["install", "--package-lock-only", "--ignore-scripts"],
      tempDir,
    );
    if (install.status !== 0) {
      throw new AuditPolicyError(
        `npm install --package-lock-only failed for ${directory} with status ${String(install.status)}: ${install.stderr.slice(0, 2000)}`,
      );
    }

    const audit = runNpm([...NPM_FULL_AUDIT_ARGS], tempDir);
    if (audit.status !== 0 && audit.status !== 1) {
      throw new AuditPolicyError(
        `npm audit exited with unexpected status ${String(audit.status)} for ${directory}`,
      );
    }

    const report = parseAuditJson(audit.stdout);
    const advisories = extractAdvisories(report);
    if (audit.status === 1 && advisories.length === 0) {
      throw new AuditPolicyError(
        `npm audit exited with status 1 without reporting advisories for ${directory}`,
      );
    }

    return advisories;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function appendSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (typeof summaryPath === "string" && summaryPath !== "") {
    appendFileSync(summaryPath, markdown, "utf8");
  }
}

function runStale() {
  const registry = readRegistry();
  const nonSecurity = readNonSecurityOverrides();
  const sync = checkSync(registry, readOverridesByDirectory(), nonSecurity);
  if (!sync.pass) {
    throw new AuditPolicyError(
      `npm-overrides.json is out of sync: ${sync.problems.join("; ")}`,
    );
  }

  if (registry.length === 0) {
    process.stdout.write("No managed npm overrides to check\n");
    return;
  }

  const advisoriesByDirectory = {};
  for (const directory of NPM_PROJECT_DIRECTORIES) {
    const registryForDirectory = registry.filter((entry) =>
      entry.directories.includes(directory),
    );
    if (registryForDirectory.length === 0) {
      continue;
    }
    advisoriesByDirectory[directory] = measureUnpinnedAdvisories(
      directory,
      registryForDirectory,
    );
  }

  const result = evaluateStaleness(registry, advisoriesByDirectory);
  const summary = renderOverridesSummary(result);
  appendSummary(summary);
  process.stdout.write(summary);

  if (!result.pass) {
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
        `Usage: npm-overrides-audit.mjs <sync|stale> (got ${String(mode)})`,
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
