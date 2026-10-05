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
//   全ての適用先（directories）で再出現しない overrides は「解除可能」として、撤去する
//   pattern の一覧を removal.json に書き出し（撤去 PR はワークフロー側が作る。Issue #310、ADR-0016）、
//   一部のディレクトリでだけ再出現しない overrides は適用先の見直しが要るため fail する
// - apply-removal モード（撤去 PR 作成 job）: artifact の removal.json を信頼できる checkout の
//   台帳と package.json で許可リスト照合し、package.json の overrides と台帳を書き換え、
//   PR のタイトル・本文・Draft の要否を書き出す。npm もネットワークも使わない
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
  mkdirSync,
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
import {
  REMOVAL_REQUEST_FILENAME,
  readRemovalRequestFile,
  workflowRunUrl,
} from "./removal-request.mjs";

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

// 撤去 PR の本文に書く Issue 参照。PR Policy Check が `Closes/Fixes/Refs #<n>` を必須とするため、
// 自動 PR では本機構を導入した Issue を参照する
const REMOVAL_PR_REFS_ISSUE = 310;
export const REMOVAL_PR_TITLE = "chore(deps): 不要になった npm overrides を撤去する";

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

// removal は selectRemovable の結果。全ての stale が「全適用先で stale」なら撤去 PR を作る
export function renderOverridesSummary(result, removal = null) {
  let status = result.pass ? "passed" : "blocked (stale overrides found)";
  if (!result.pass && removal !== null && removal.partial.length === 0) {
    status = "removable: removal pull request will be created";
  }
  const lines = [
    "## npm overrides inventory (stale check)",
    "",
    `- Result: ${status}`,
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

  if (removal !== null && removal.partial.length > 0) {
    lines.push(
      "",
      "> [!CAUTION]",
      "> Some overrides are stale in only part of their directories. Narrow `directories` (and the package.json overrides) by hand; no removal pull request is created while this persists:",
      "",
    );
    for (const item of removal.partial) {
      lines.push(
        `- ${escapeMarkdown(item.pattern)}: stale in ${escapeMarkdown(
          item.staleIn.join(", "),
        )}, still needed in ${escapeMarkdown(item.neededIn.join(", "))}`,
      );
    }
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

// 全ての適用先で stale のエントリだけを撤去対象にする。ルートと skeleton に同じ overrides を
// 入れるのが運用上の不変条件（security-scanning.md）なので、片方だけ stale のエントリは
// 自動では外さず、人に適用先の見直しを求める（partial）
export function selectRemovable(registry, result) {
  const removable = [];
  const partial = [];
  for (const entry of registry) {
    const staleIn = result.stale
      .filter((item) => item.pattern === entry.pattern)
      .map((item) => item.directory);
    if (staleIn.length === 0) {
      continue;
    }
    const neededIn = entry.directories.filter((directory) => !staleIn.includes(directory));
    if (neededIn.length === 0) {
      removable.push(entry);
    } else {
      partial.push({ pattern: entry.pattern, staleIn, neededIn });
    }
  }
  return { removable, partial };
}

// ---- probe job（secret なし）と PR 作成 job（App トークンあり）の境界 ----
//
// ADR-0015 選択肢 8 / ADR-0016 と同じ。job 間を渡るのは artifact の removal.json 1 ファイルだけで、
// 中身は「外す overrides の pattern 一覧」と「lockfile が変わるか」の真偽値に限る。
// probe job は上流の最新を引いて lockfile を再解決するため、そこで作られたファイル
// （package.json・台帳・lockfile・PR 本文）を App 名義の PR に入れない。PR 作成 job は
// 信頼できる checkout から package.json・台帳・PR 本文を自分で生成する。lockfile は PR に含めず、
// 変わる場合は Draft にして人が `npm install` を 1 コミット足す（ADR-0015 の案 A）
export function parseOverridesRemovalRequest(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AuditPolicyError(`removal request must be valid JSON: ${error.message}`);
  }
  if (!isRecord(parsed)) {
    throw new AuditPolicyError("removal request must be a JSON object");
  }
  const keys = Object.keys(parsed).sort();
  if (keys.length !== 2 || keys[0] !== "lockfileChanges" || keys[1] !== "patterns") {
    throw new AuditPolicyError(
      "removal request must contain exactly patterns and lockfileChanges",
    );
  }
  if (
    !Array.isArray(parsed.patterns) ||
    parsed.patterns.length === 0 ||
    parsed.patterns.some(
      (pattern) => typeof pattern !== "string" || !PACKAGE_NAME_PATTERN.test(pattern),
    )
  ) {
    throw new AuditPolicyError(
      "removal request patterns must be a non-empty array of npm package names",
    );
  }
  if (new Set(parsed.patterns).size !== parsed.patterns.length) {
    throw new AuditPolicyError("removal request patterns contains duplicates");
  }
  if (typeof parsed.lockfileChanges !== "boolean") {
    throw new AuditPolicyError("removal request lockfileChanges must be a boolean");
  }
  return { patterns: [...parsed.patterns], lockfileChanges: parsed.lockfileChanges };
}

// 信頼できる checkout の台帳で pattern を許可リスト照合する。
// 台帳（セキュリティ起因）のエントリだけを通す。非セキュリティ宣言は棚卸しの対象外なので外さない
export function authorizeOverridesRemoval(request, registry) {
  return request.patterns.map((pattern) => {
    const entry = registry.find((candidate) => candidate.pattern === pattern);
    if (entry === undefined) {
      throw new AuditPolicyError(
        `removal request names ${pattern}, which is not registered in npm-overrides.json`,
      );
    }
    return entry;
  });
}

// package.json（ディレクトリごと）と台帳から、撤去対象の overrides を取り除く。
// overrides が空になったらキーごと削除する（npm の既定の package.json に戻す）
export function applyOverridesRemoval(manifestsByDirectory, registry, entries) {
  const patterns = new Set(entries.map((entry) => entry.pattern));
  const manifests = {};
  for (const entry of entries) {
    for (const directory of entry.directories) {
      const manifest = manifests[directory] ?? structuredClone(manifestsByDirectory[directory]);
      if (!isRecord(manifest) || !isRecord(manifest.overrides)) {
        throw new AuditPolicyError(`${directory}/package.json has no overrides to remove`);
      }
      if (manifest.overrides[entry.pattern] === undefined) {
        throw new AuditPolicyError(
          `${directory}/package.json overrides has no ${entry.pattern}`,
        );
      }
      delete manifest.overrides[entry.pattern];
      if (Object.keys(manifest.overrides).length === 0) {
        delete manifest.overrides;
      }
      manifests[directory] = manifest;
    }
  }
  return {
    manifests,
    registry: registry.filter((entry) => !patterns.has(entry.pattern)),
  };
}

// 撤去 PR の本文。PR テンプレート（.github/pull_request_template.md）の見出しに揃える
export function renderOverridesRemovalPullRequestBody(entries, options = {}) {
  const runUrl = options.runUrl ?? null;
  const lockfileChanges = options.lockfileChanges === true;
  const directories = [...new Set(entries.flatMap((entry) => entry.directories))];
  const lines = [
    ...(lockfileChanges
      ? [
          "> [!IMPORTANT]",
          `> **この PR は Draft です。${directories
            .map((directory) => `\`${directory}\``)
            .join(" と ")} で \`npm install --package-lock-only --ignore-scripts\` を実行して \`package-lock.json\` をコミットしてから Ready for review にする。**`,
          "> probe の実測で、この overrides を外すと `package-lock.json` が変わることが分かっている。lock を足さないと `npm ci` が通らない。",
          "",
        ]
      : []),
    "## 目的",
    "",
    "npm Overrides Inventory の棚卸しで、次のセキュリティ起因の npm overrides が全ての適用先で不要になったことを実測した（外して lockfile を再解決しても、台帳記載の advisory が再出現しない）。",
    runUrl === null ? null : `棚卸しを実行した run: ${runUrl}`,
    "",
    "| Pattern | Override | Directories | Advisories |",
    "| --- | --- | --- | --- |",
    ...entries.map(
      (entry) =>
        `| \`${escapeMarkdown(entry.pattern)}\` | \`${escapeMarkdown(
          entry.override,
        )}\` | ${entry.directories
          .map((directory) => `\`${escapeMarkdown(directory)}\``)
          .join(", ")} | ${entry.advisories.map(escapeMarkdown).join(", ")} |`,
    ),
    "",
    "## 変更内容",
    "",
    "- 上記ディレクトリの `package.json` の `overrides` から上記の行を削除（空になればキーごと削除）",
    "- `scripts/ci/npm-overrides.json` から上記のエントリを削除",
    "- `package-lock.json` は変更しない（probe job の成果物を信用しないため。ADR-0015 / ADR-0016）",
    "",
    lockfileChanges
      ? "probe の実測では、この overrides を外すと `package-lock.json` が変わる（冒頭の手順で lock を足す）。"
      : "probe の実測では、この overrides を外しても `package-lock.json` は変わらない。",
    "",
    "## 影響範囲",
    "",
    "- **対象**: ルート / skeleton の npm 依存解決（上記 overrides が効いていた依存のみ）",
    "- **非対象**: yarn の resolutions（`backstage/`）、非セキュリティ起因の overrides、Dependabot の更新 PR",
    "",
    "## 可観測性/検証",
    "",
    "- 棚卸し: overrides を外した一時プロジェクトで `npm install --package-lock-only --ignore-scripts` → `npm audit` を実行し、台帳記載の advisory が全ての適用先で再出現しない",
    "- 撤去対象だけを外した一時プロジェクトでも、外す前に無かった High / Critical が新たに出ないことを確認済み",
    "- マージ前に `npm Dependency Audit (root / skeleton)` と `npm Overrides Registry` が通ることを確認する",
    "",
    "## メモ（レビューポイント）",
    "",
    "- この PR は Dependency Audit ワークフローの npm Overrides Inventory が自動作成した（正本: `docs/operations/security-scanning.md`、設計判断: ADR-0016）。差分は PR 作成 job が信頼できる checkout から生成しており、probe job からは外す pattern の一覧だけを受け取っている",
    "- 再実行しても同じブランチが更新され、PR は重複しない",
    "",
    `Refs #${REMOVAL_PR_REFS_ISSUE}`,
  ];
  return `${lines.filter((line) => line !== null).join("\n")}\n`;
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

// registryForDirectory の overrides を外した一時プロジェクトを作る（空配列なら現状のまま複製）
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

// --ignore-scripts: 一時プロジェクトで依存の lifecycle script を走らせない
// （lockfile の再解決だけが目的で、node_modules も作らない）
function resolveLockfile(tempDir, directory) {
  const install = runNpm(
    ["install", "--package-lock-only", "--ignore-scripts"],
    tempDir,
  );
  if (install.status !== 0) {
    throw new AuditPolicyError(
      `npm install --package-lock-only failed for ${directory} with status ${String(install.status)}: ${install.stderr.slice(0, 2000)}`,
    );
  }
}

function auditProject(tempDir, directory) {
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
}

function measureUnpinnedAdvisories(directory, registryForDirectory) {
  const tempDir = buildUnpinnedProject(directory, registryForDirectory);
  try {
    resolveLockfile(tempDir, directory);
    return auditProject(tempDir, directory);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function highOrCriticalKeys(advisories) {
  return new Set(
    advisories
      .filter((advisory) => advisory.severity === "high" || advisory.severity === "critical")
      .map((advisory) => `${advisory.package} ${advisory.ghsa ?? advisory.title}`),
  );
}

// 撤去後の状態で High / Critical が増えないこと（他の overrides との相互作用や、台帳未記載の
// advisory の見落とし対策）を確かめ、lockfile が変わるかを測る。新たな High / Critical が
// 出た場合は機構の故障として fail し、撤去 PR を作らない
export function findIntroducedAdvisories(baseline, after) {
  const before = highOrCriticalKeys(baseline);
  return [...highOrCriticalKeys(after)].filter((key) => !before.has(key));
}

function measureRemoval(directory, entriesForDirectory) {
  const baselineDir = buildUnpinnedProject(directory, []);
  let baseline;
  try {
    baseline = auditProject(baselineDir, directory);
  } finally {
    rmSync(baselineDir, { recursive: true, force: true });
  }

  const removedDir = buildUnpinnedProject(directory, entriesForDirectory);
  try {
    resolveLockfile(removedDir, directory);
    const introduced = findIntroducedAdvisories(baseline, auditProject(removedDir, directory));
    if (introduced.length > 0) {
      throw new AuditPolicyError(
        `removing ${entriesForDirectory
          .map((entry) => entry.pattern)
          .join(", ")} in ${directory} introduces High / Critical advisories: ${introduced.join("; ")}`,
      );
    }
    return (
      readFileSync(join(removedDir, "package-lock.json"), "utf8") !==
      readFileSync(join(REPO_ROOT, directory, "package-lock.json"), "utf8")
    );
  } finally {
    rmSync(removedDir, { recursive: true, force: true });
  }
}

function writeRemovalRequest(removable, outputDir) {
  let lockfileChanges = false;
  for (const directory of NPM_PROJECT_DIRECTORIES) {
    const entriesForDirectory = removable.filter((entry) =>
      entry.directories.includes(directory),
    );
    if (entriesForDirectory.length > 0 && measureRemoval(directory, entriesForDirectory)) {
      lockfileChanges = true;
    }
  }
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(
    join(outputDir, REMOVAL_REQUEST_FILENAME),
    `${JSON.stringify(
      { patterns: removable.map((entry) => entry.pattern), lockfileChanges },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return lockfileChanges;
}

function writeGitHubOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (typeof outputPath === "string" && outputPath !== "") {
    appendFileSync(outputPath, `${name}=${value}\n`, "utf8");
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
    writeGitHubOutput("removal", "false");
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
  const removal = selectRemovable(registry, result);
  const summary = renderOverridesSummary(result, removal);
  appendSummary(summary);
  process.stdout.write(summary);

  // 一部の適用先でだけ stale なエントリがある間は、人の判断が要るので赤にし、撤去 PR は作らない
  if (removal.partial.length > 0) {
    writeGitHubOutput("removal", "false");
    process.exitCode = 1;
    return;
  }

  const outputDir = process.env.IDP_OVERRIDES_REMOVAL_DIR;
  if (removal.removable.length > 0) {
    // 撤去 PR を作る経路（本リポジトリの schedule / workflow_dispatch）が無いローカル実行では、
    // 従来どおり stale を fail で知らせる
    if (typeof outputDir !== "string" || outputDir === "") {
      process.exitCode = 1;
      return;
    }
    const lockfileChanges = writeRemovalRequest(removal.removable, outputDir);
    process.stdout.write(
      `removal request written to ${join(outputDir, REMOVAL_REQUEST_FILENAME)} (lockfile changes: ${String(lockfileChanges)})\n`,
    );
    writeGitHubOutput("removal", "true");
    return;
  }
  writeGitHubOutput("removal", "false");
}

// PR 作成 job 側。artifact（IDP_OVERRIDES_REMOVAL_DIR）の removal.json を検証し、
// 信頼できる checkout の台帳・package.json と照合した上で、作業ツリーの package.json と台帳を
// 書き換え、PR 本文・タイトル・Draft の要否を IDP_OVERRIDES_PR_DIR に書く
export function runApplyRemoval(options) {
  const { requestDir, prDir, rootDir = REPO_ROOT, runUrl = null } = options;
  if (typeof requestDir !== "string" || requestDir === "" || typeof prDir !== "string" || prDir === "") {
    throw new AuditPolicyError(
      "apply-removal requires IDP_OVERRIDES_REMOVAL_DIR and IDP_OVERRIDES_PR_DIR",
    );
  }

  const request = parseOverridesRemovalRequest(
    readRemovalRequestFile(requestDir, AuditPolicyError),
  );

  const registryPath = join(rootDir, "scripts", "ci", "npm-overrides.json");
  const nonSecurityPath = join(rootDir, "scripts", "ci", "npm-overrides-non-security.json");
  const registry = parseOverridesRegistry(readFileSync(registryPath, "utf8"));
  const nonSecurity = existsSync(nonSecurityPath)
    ? parseNonSecurityOverrides(readFileSync(nonSecurityPath, "utf8"))
    : [];
  const manifestsByDirectory = {};
  const overridesByDirectory = {};
  for (const directory of NPM_PROJECT_DIRECTORIES) {
    const manifest = JSON.parse(
      readFileSync(join(rootDir, directory, "package.json"), "utf8"),
    );
    manifestsByDirectory[directory] = manifest;
    overridesByDirectory[directory] = manifest.overrides ?? {};
  }
  const before = checkSync(registry, overridesByDirectory, nonSecurity);
  if (!before.pass) {
    throw new AuditPolicyError(
      `npm-overrides.json is out of sync: ${before.problems.join("; ")}`,
    );
  }

  const entries = authorizeOverridesRemoval(request, registry);
  const removed = applyOverridesRemoval(manifestsByDirectory, registry, entries);

  // 撤去後も台帳と package.json が同期していることを確かめてから書き込む
  const nextOverrides = { ...overridesByDirectory };
  for (const [directory, manifest] of Object.entries(removed.manifests)) {
    nextOverrides[directory] = manifest.overrides ?? {};
  }
  const after = checkSync(removed.registry, nextOverrides, nonSecurity);
  if (!after.pass) {
    throw new AuditPolicyError(
      `npm-overrides.json would be out of sync after the removal: ${after.problems.join("; ")}`,
    );
  }

  for (const [directory, manifest] of Object.entries(removed.manifests)) {
    writeFileSync(
      join(rootDir, directory, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
  }
  writeFileSync(registryPath, `${JSON.stringify(removed.registry, null, 2)}\n`, "utf8");

  mkdirSync(prDir, { recursive: true });
  writeFileSync(
    join(prDir, "pull-request-body.md"),
    renderOverridesRemovalPullRequestBody(entries, {
      runUrl,
      lockfileChanges: request.lockfileChanges,
    }),
    "utf8",
  );
  writeFileSync(join(prDir, "pull-request-title.txt"), `${REMOVAL_PR_TITLE}\n`, "utf8");
  // lock の更新が要る PR は Draft にする（GitHub の仕様でマージできず、人の作業が要る目印になる）
  writeFileSync(
    join(prDir, "pull-request-draft.txt"),
    `${String(request.lockfileChanges)}\n`,
    "utf8",
  );
  return entries;
}

async function main() {
  const mode = process.argv[2];

  try {
    if (mode === "sync") {
      runSync();
    } else if (mode === "stale") {
      runStale();
    } else if (mode === "apply-removal") {
      const entries = runApplyRemoval({
        requestDir: process.env.IDP_OVERRIDES_REMOVAL_DIR,
        prDir: process.env.IDP_OVERRIDES_PR_DIR,
        runUrl: workflowRunUrl(),
      });
      process.stdout.write(
        `removing npm overrides: ${entries.map((entry) => entry.pattern).join(", ")}\n`,
      );
    } else {
      throw new AuditPolicyError(
        `Usage: npm-overrides-audit.mjs <sync|stale|apply-removal> (got ${String(mode)})`,
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
