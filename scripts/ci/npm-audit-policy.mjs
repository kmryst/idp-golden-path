#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const GHSA_PATTERN = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;
const TRACKING_ISSUE_PATTERN =
  /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}\/issues\/[1-9][0-9]*$/;
const DATE_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const MAX_EXCEPTION_TTL_DAYS = 90;
const THRESHOLD_SEVERITIES = new Set(["high", "critical"]);
const SEVERITY_RANK = new Map([
  ["info", 0],
  ["low", 1],
  ["moderate", 2],
  ["high", 3],
  ["critical", 4],
]);

export const NPM_RUNTIME_AUDIT_ARGS = Object.freeze([
  "audit",
  "--package-lock=true",
  "--package-lock-only=true",
  "--omit=dev",
  "--include=prod",
  "--include=optional",
  "--include=peer",
  "--audit-level=high",
  "--json",
]);

export const NPM_FULL_AUDIT_ARGS = Object.freeze([
  "audit",
  "--package-lock=true",
  "--package-lock-only=true",
  "--include=prod",
  "--include=dev",
  "--include=optional",
  "--include=peer",
  "--json",
]);

export class AuditPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuditPolicyError";
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function canonicalGhsaFromAdvisoryUrl(value) {
  if (typeof value !== "string") {
    return null;
  }

  const match = value.match(
    /^https:\/\/github\.com\/advisories\/GHSA-([a-z0-9]{4})-([a-z0-9]{4})-([a-z0-9]{4})\/?$/i,
  );
  if (match === null) {
    return null;
  }

  return `GHSA-${match[1].toLowerCase()}-${match[2].toLowerCase()}-${match[3].toLowerCase()}`;
}

function currentUtcDate(now) {
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) {
    throw new AuditPolicyError("Current time is invalid");
  }

  return now.toISOString().slice(0, 10);
}

function validateDate(value, fieldName) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    throw new AuditPolicyError(`${fieldName} must use YYYY-MM-DD`);
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new AuditPolicyError(`${fieldName} is not a valid calendar date`);
  }
}

export function parseExceptions(
  raw,
  now = new Date(),
  inputName = "npm-audit-exceptions",
) {
  let parsed;

  try {
    parsed = JSON.parse(raw === undefined || raw.trim() === "" ? "[]" : raw);
  } catch (error) {
    throw new AuditPolicyError(`${inputName} must be valid JSON: ${error.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new AuditPolicyError(`${inputName} must be a JSON array`);
  }

  const today = currentUtcDate(now);
  const maximumExpiry = new Date(`${today}T00:00:00.000Z`);
  maximumExpiry.setUTCDate(maximumExpiry.getUTCDate() + MAX_EXCEPTION_TTL_DAYS);
  const maximumExpiryDate = maximumExpiry.toISOString().slice(0, 10);
  const seenIds = new Set();

  return parsed.map((entry, index) => {
    const label = `${inputName}[${index}]`;
    if (!isRecord(entry)) {
      throw new AuditPolicyError(`${label} must be an object`);
    }

    const keys = Object.keys(entry).sort();
    const expectedKeys = ["expires", "id", "tracking"];
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key, keyIndex) => key !== expectedKeys[keyIndex])
    ) {
      throw new AuditPolicyError(
        `${label} must contain exactly id, expires, and tracking`,
      );
    }

    if (typeof entry.id !== "string" || !GHSA_PATTERN.test(entry.id)) {
      throw new AuditPolicyError(
        `${label}.id must be a canonical GHSA ID such as GHSA-xxxx-xxxx-xxxx`,
      );
    }
    if (seenIds.has(entry.id)) {
      throw new AuditPolicyError(`${label}.id duplicates ${entry.id}`);
    }
    seenIds.add(entry.id);

    validateDate(entry.expires, `${label}.expires`);
    if (entry.expires < today) {
      throw new AuditPolicyError(
        `${label}.expires (${entry.expires}) is before the current UTC date (${today})`,
      );
    }
    if (entry.expires > maximumExpiryDate) {
      throw new AuditPolicyError(
        `${label}.expires (${entry.expires}) exceeds the ${MAX_EXCEPTION_TTL_DAYS}-day maximum (${maximumExpiryDate})`,
      );
    }

    if (
      typeof entry.tracking !== "string" ||
      !TRACKING_ISSUE_PATTERN.test(entry.tracking)
    ) {
      throw new AuditPolicyError(`${label}.tracking must be a GitHub Issue URL`);
    }

    return {
      id: entry.id,
      expires: entry.expires,
      tracking: entry.tracking,
    };
  });
}

function normalizeSeverity(value, label) {
  if (typeof value !== "string") {
    throw new AuditPolicyError(`${label} is missing a severity`);
  }

  const severity = value.toLowerCase();
  if (!SEVERITY_RANK.has(severity)) {
    throw new AuditPolicyError(`${label} has an unknown severity: ${value}`);
  }

  return severity;
}

function higherSeverity(left, right) {
  return SEVERITY_RANK.get(left) >= SEVERITY_RANK.get(right) ? left : right;
}

function validateAuditReport(report) {
  if (!isRecord(report)) {
    throw new AuditPolicyError("npm audit output must be a JSON object");
  }

  if (report.error !== undefined) {
    const code = isRecord(report.error) ? report.error.code : undefined;
    throw new AuditPolicyError(
      `npm audit returned an error${typeof code === "string" ? ` (${code})` : ""}`,
    );
  }

  if (!isRecord(report.vulnerabilities)) {
    throw new AuditPolicyError("npm audit output is missing vulnerabilities");
  }

  if (
    !isRecord(report.metadata) ||
    !isRecord(report.metadata.vulnerabilities)
  ) {
    throw new AuditPolicyError(
      "npm audit output is missing metadata.vulnerabilities",
    );
  }

  for (const severity of ["high", "critical"]) {
    const count = report.metadata.vulnerabilities[severity];
    if (!Number.isInteger(count) || count < 0) {
      throw new AuditPolicyError(
        `npm audit metadata.vulnerabilities.${severity} must be a non-negative integer`,
      );
    }
  }

  return report;
}

export function parseAuditJson(raw) {
  let report;

  try {
    report = JSON.parse(raw);
  } catch (error) {
    throw new AuditPolicyError(`npm audit did not return valid JSON: ${error.message}`);
  }

  return validateAuditReport(report);
}

function resolveRootAdvisories(
  packageName,
  vulnerabilities,
  activePackages = new Set(),
  cache = new Map(),
) {
  if (cache.has(packageName)) {
    return cache.get(packageName);
  }

  if (activePackages.has(packageName)) {
    throw new AuditPolicyError(
      `npm audit via chain contains a cycle at ${packageName}`,
    );
  }

  const vulnerability = vulnerabilities[packageName];
  if (!isRecord(vulnerability) || !Array.isArray(vulnerability.via)) {
    throw new AuditPolicyError(
      `npm audit via chain references ${packageName} without a valid vulnerability entry`,
    );
  }

  const nextActivePackages = new Set(activePackages);
  nextActivePackages.add(packageName);
  const roots = [];

  for (const via of vulnerability.via) {
    if (typeof via === "string") {
      roots.push(
        ...resolveRootAdvisories(
          via,
          vulnerabilities,
          nextActivePackages,
          cache,
        ),
      );
      continue;
    }

    if (!isRecord(via)) {
      throw new AuditPolicyError(
        `npm audit via entry for ${packageName} has an unsupported type`,
      );
    }

    roots.push(via);
  }

  if (roots.length === 0) {
    throw new AuditPolicyError(
      `npm audit could not resolve a root advisory for ${packageName}`,
    );
  }

  cache.set(packageName, roots);
  return roots;
}

function findingKey(advisory) {
  const ghsa = canonicalGhsaFromAdvisoryUrl(advisory.url);
  if (ghsa !== null) {
    return ghsa;
  }

  if (advisory.source !== undefined) {
    return `source:${String(advisory.source)}`;
  }

  return `unidentified:${String(advisory.name ?? "unknown")}:${String(
    advisory.title ?? "unknown",
  )}`;
}

export function evaluateAuditReport(reportValue, exceptions) {
  const report = validateAuditReport(reportValue);
  const exceptionById = new Map(exceptions.map((entry) => [entry.id, entry]));
  const findingByKey = new Map();
  const rootCache = new Map();
  const thresholdPackageCounts = {
    high: 0,
    critical: 0,
  };

  for (const [packageName, vulnerability] of Object.entries(
    report.vulnerabilities,
  )) {
    if (!isRecord(vulnerability)) {
      throw new AuditPolicyError(
        `npm audit vulnerability entry for ${packageName} must be an object`,
      );
    }

    const packageSeverity = normalizeSeverity(
      vulnerability.severity,
      `npm audit vulnerability ${packageName}`,
    );
    if (!THRESHOLD_SEVERITIES.has(packageSeverity)) {
      continue;
    }

    thresholdPackageCounts[packageSeverity] += 1;
    const roots = resolveRootAdvisories(
      packageName,
      report.vulnerabilities,
      new Set(),
      rootCache,
    );
    const thresholdRoots = roots.filter((root) =>
      THRESHOLD_SEVERITIES.has(
        normalizeSeverity(
          root.severity,
          `npm audit root advisory for ${packageName}`,
        ),
      ),
    );

    if (thresholdRoots.length === 0) {
      throw new AuditPolicyError(
        `npm audit could not resolve a High or Critical root advisory for ${packageName}`,
      );
    }

    for (const root of thresholdRoots) {
      const rootSeverity = normalizeSeverity(
        root.severity,
        `npm audit root advisory for ${packageName}`,
      );
      const severity = higherSeverity(packageSeverity, rootSeverity);
      const key = findingKey(root);
      const id = canonicalGhsaFromAdvisoryUrl(root.url);
      const existing = findingByKey.get(key);

      if (existing === undefined) {
        findingByKey.set(key, {
          key,
          id,
          severity,
          title:
            typeof root.title === "string" && root.title.trim() !== ""
              ? root.title.trim()
              : "Untitled advisory",
          packages: new Set([packageName]),
        });
      } else {
        existing.severity = higherSeverity(existing.severity, severity);
        existing.packages.add(packageName);
      }
    }
  }

  for (const severity of ["high", "critical"]) {
    if (
      report.metadata.vulnerabilities[severity] !==
      thresholdPackageCounts[severity]
    ) {
      throw new AuditPolicyError(
        `npm audit metadata ${severity} count does not match vulnerability entries`,
      );
    }
  }

  const findings = [...findingByKey.values()].map((finding) => ({
    ...finding,
    packages: [...finding.packages].sort(),
  }));
  const allowed = [];
  const blocked = [];

  for (const finding of findings) {
    const exception =
      finding.id === null ? undefined : exceptionById.get(finding.id);

    if (
      finding.severity === "high" &&
      finding.id !== null &&
      exception !== undefined
    ) {
      allowed.push({ ...finding, exception });
      continue;
    }

    blocked.push({
      ...finding,
      reason:
        finding.severity === "critical"
          ? "Critical advisories cannot be excepted"
          : finding.id === null
            ? "The root advisory has no GHSA ID"
            : "The GHSA is not in the active exception list",
    });
  }

  const detectedIds = new Set(
    findings
      .map((finding) => finding.id)
      .filter((id) => typeof id === "string"),
  );
  const unused = exceptions.filter((entry) => !detectedIds.has(entry.id));

  return {
    pass: blocked.length === 0,
    allowed,
    blocked,
    unused,
  };
}

export function assertRuntimeAuditPassed(reportValue, status = 0) {
  const report = validateAuditReport(reportValue);
  const result = evaluateAuditReport(report, []);

  if (status !== 0 || !result.pass) {
    throw new AuditPolicyError(
      "Runtime dependencies contain a High or Critical vulnerability",
    );
  }

  return report;
}

function runNpmAudit(args) {
  const result = spawnSync("npm", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });

  if (result.error !== undefined) {
    throw new AuditPolicyError(`Failed to execute npm audit: ${result.error.message}`);
  }
  if (result.signal !== null) {
    throw new AuditPolicyError(`npm audit was terminated by signal ${result.signal}`);
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new AuditPolicyError(
      `npm audit exited with unexpected status ${String(result.status)}`,
    );
  }

  const report = parseAuditJson(result.stdout);
  return { report, status: result.status };
}

export function escapeMarkdown(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ");
}

export function renderSummary(exceptions, result) {
  const allowedById = new Map(
    result.allowed.map((finding) => [finding.id, finding]),
  );
  const blockedById = new Map(
    result.blocked
      .filter((finding) => finding.id !== null)
      .map((finding) => [finding.id, finding]),
  );
  const lines = [
    "## Dependency Audit exception gate (npm)",
    "",
    "- Runtime dependencies: passed the unfiltered High / Critical gate",
    `- Full dependency graph: ${result.pass ? "passed" : "blocked"}`,
    "",
    "| Advisory | Severity | Affected packages | Expires (UTC) | Tracking | Status |",
    "| --- | --- | --- | --- | --- | --- |",
  ];

  for (const exception of exceptions) {
    const allowed = allowedById.get(exception.id);
    const blocked = blockedById.get(exception.id);
    const finding = allowed ?? blocked;
    const severity = finding?.severity ?? "-";
    const packages =
      finding === undefined || finding.packages.length === 0
        ? "-"
        : finding.packages.join(", ");
    const status =
      allowed !== undefined
        ? "allowed temporarily"
        : blocked !== undefined
          ? `blocked: ${blocked.reason}`
          : "not detected (remove the stale exception)";

    lines.push(
      `| ${escapeMarkdown(exception.id)} | ${escapeMarkdown(severity)} | ${escapeMarkdown(
        packages,
      )} | ${escapeMarkdown(exception.expires)} | [Issue](${exception.tracking}) | ${escapeMarkdown(
        status,
      )} |`,
    );
  }

  const unconfiguredBlocked = result.blocked.filter(
    (finding) => finding.id === null || !allowedById.has(finding.id),
  );
  if (unconfiguredBlocked.length > 0) {
    lines.push("", "### Blocking advisories", "");
    for (const finding of unconfiguredBlocked) {
      lines.push(
        `- ${escapeMarkdown(finding.id ?? finding.key)} (${escapeMarkdown(
          finding.severity,
        )}): ${escapeMarkdown(finding.reason)}; packages: ${escapeMarkdown(
          finding.packages.join(", "),
        )}`,
      );
    }
  }

  if (result.unused.length > 0) {
    lines.push(
      "",
      "> [!WARNING]",
      "> One or more configured exceptions were not detected. Remove stale exceptions in a follow-up PR; they remain bounded by their expiry date.",
    );
  }

  return `${lines.join("\n")}\n`;
}

function appendSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (typeof summaryPath === "string" && summaryPath !== "") {
    appendFileSync(summaryPath, markdown, "utf8");
  }
}

function renderErrorSummary(error) {
  return [
    "## Dependency Audit exception gate (npm)",
    "",
    "The gate failed closed before an exception could be applied.",
    "",
    `- Error: ${escapeMarkdown(error.message)}`,
    "",
  ].join("\n");
}

async function main() {
  try {
    const exceptions = parseExceptions(
      process.env.NPM_AUDIT_EXCEPTIONS ?? "[]",
    );
    if (exceptions.length === 0) {
      throw new AuditPolicyError(
        "The exception evaluator requires at least one configured exception",
      );
    }

    const runtime = runNpmAudit(NPM_RUNTIME_AUDIT_ARGS);
    assertRuntimeAuditPassed(runtime.report, runtime.status);

    const full = runNpmAudit(NPM_FULL_AUDIT_ARGS);
    const fullVulnerabilityCount = Object.keys(
      full.report.vulnerabilities,
    ).length;
    if (full.status === 1 && fullVulnerabilityCount === 0) {
      throw new AuditPolicyError(
        "npm audit exited with status 1 without reporting vulnerabilities",
      );
    }

    const result = evaluateAuditReport(full.report, exceptions);
    const summary = renderSummary(exceptions, result);
    appendSummary(summary);
    process.stdout.write(summary);

    if (!result.pass) {
      process.exitCode = 1;
    }
  } catch (error) {
    const policyError =
      error instanceof AuditPolicyError
        ? error
        : new AuditPolicyError(`Unexpected evaluator error: ${error.message}`);
    const summary = renderErrorSummary(policyError);
    appendSummary(summary);
    process.stderr.write(`${summary}\n`);
    process.exitCode = 1;
  }
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedAsScript) {
  await main();
}
