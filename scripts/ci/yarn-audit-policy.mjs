#!/usr/bin/env node

// Dependency Audit（yarn パス）の期限付き例外評価器。
// npm 側（npm-audit-policy.mjs）の設計を踏襲し、Yarn 4 の
// `yarn npm audit --all --recursive --json`（NDJSON: 1 advisory = 1 行）を評価する。
//
// npm 側との意図的な差分:
// - runtime（--omit=dev 相当）の事前ゲートは持たない。Yarn workspaces の
//   モノレポではフロントエンド実行時依存も production に分類され、
//   環境分割が npm 側の「開発依存のみ例外可」という境界として機能しないため、
//   ガードは severity（Critical 例外不可）・期限（最大 90 日）・追跡 Issue に一本化する。
//   正本: docs/operations/security-scanning.md

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  AuditPolicyError,
  canonicalGhsaFromAdvisoryUrl,
  escapeMarkdown,
  parseExceptions,
} from "./npm-audit-policy.mjs";

const EXCEPTIONS_INPUT_NAME = "yarn-audit-exceptions";
const THRESHOLD_SEVERITIES = new Set(["high", "critical"]);
const KNOWN_SEVERITIES = new Set(["info", "low", "moderate", "high", "critical"]);
const SEVERITY_RANK = new Map([
  ["info", 0],
  ["low", 1],
  ["moderate", 2],
  ["high", 3],
  ["critical", 4],
]);

export const YARN_AUDIT_ARGS = Object.freeze([
  "npm",
  "audit",
  "--all",
  "--recursive",
  "--json",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeSeverity(value, label) {
  if (typeof value !== "string") {
    throw new AuditPolicyError(`${label} is missing a severity`);
  }

  const severity = value.toLowerCase();
  if (!KNOWN_SEVERITIES.has(severity)) {
    throw new AuditPolicyError(`${label} has an unknown severity: ${value}`);
  }

  return severity;
}

function higherSeverity(left, right) {
  return SEVERITY_RANK.get(left) >= SEVERITY_RANK.get(right) ? left : right;
}

export function parseYarnAuditOutput(raw) {
  if (typeof raw !== "string") {
    throw new AuditPolicyError("yarn npm audit did not produce readable output");
  }

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

  return lines.map((line, index) => {
    const label = `yarn npm audit output line ${index + 1}`;
    let entry;

    try {
      entry = JSON.parse(line);
    } catch (error) {
      throw new AuditPolicyError(`${label} is not valid JSON: ${error.message}`);
    }

    if (!isRecord(entry) || typeof entry.value !== "string" || entry.value === "") {
      throw new AuditPolicyError(`${label} is missing the affected package name`);
    }
    if (!isRecord(entry.children)) {
      throw new AuditPolicyError(`${label} is missing advisory details`);
    }

    const severity = normalizeSeverity(entry.children.Severity, label);
    const advisoryId = entry.children.ID;
    if (typeof advisoryId !== "number" && typeof advisoryId !== "string") {
      throw new AuditPolicyError(`${label} is missing the advisory ID`);
    }

    return {
      package: entry.value,
      advisoryId: String(advisoryId),
      ghsa: canonicalGhsaFromAdvisoryUrl(entry.children.URL),
      severity,
      title:
        typeof entry.children.Issue === "string" &&
        entry.children.Issue.trim() !== ""
          ? entry.children.Issue.trim()
          : "Untitled advisory",
    };
  });
}

export function evaluateYarnAudit(advisories, exceptions) {
  if (!Array.isArray(advisories)) {
    throw new AuditPolicyError("yarn audit advisories must be an array");
  }

  const exceptionById = new Map(exceptions.map((entry) => [entry.id, entry]));
  const findingByKey = new Map();

  for (const advisory of advisories) {
    if (!THRESHOLD_SEVERITIES.has(advisory.severity)) {
      continue;
    }

    const key = advisory.ghsa ?? `advisory:${advisory.advisoryId}`;
    const existing = findingByKey.get(key);

    if (existing === undefined) {
      findingByKey.set(key, {
        key,
        id: advisory.ghsa,
        severity: advisory.severity,
        title: advisory.title,
        packages: new Set([advisory.package]),
      });
    } else {
      existing.severity = higherSeverity(existing.severity, advisory.severity);
      existing.packages.add(advisory.package);
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
            ? "The advisory has no GHSA ID"
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

export function renderYarnSummary(exceptions, result) {
  const allowedById = new Map(
    result.allowed.map((finding) => [finding.id, finding]),
  );
  const blockedById = new Map(
    result.blocked
      .filter((finding) => finding.id !== null)
      .map((finding) => [finding.id, finding]),
  );
  const lines = [
    "## Dependency Audit exception gate (yarn)",
    "",
    "- Scope: full workspace graph (`--all --recursive`); Critical advisories can never be excepted",
    `- Result: ${result.pass ? "passed" : "blocked"}`,
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

function runYarnAudit() {
  const result = spawnSync("yarn", YARN_AUDIT_ARGS, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });

  if (result.error !== undefined) {
    throw new AuditPolicyError(
      `Failed to execute yarn npm audit: ${result.error.message}`,
    );
  }
  if (result.signal !== null) {
    throw new AuditPolicyError(
      `yarn npm audit was terminated by signal ${result.signal}`,
    );
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new AuditPolicyError(
      `yarn npm audit exited with unexpected status ${String(result.status)}`,
    );
  }

  return { advisories: parseYarnAuditOutput(result.stdout), status: result.status };
}

export function assertYarnAuditConsistency(advisories, status) {
  if (status === 1 && advisories.length === 0) {
    throw new AuditPolicyError(
      "yarn npm audit exited with status 1 without reporting advisories",
    );
  }
  if (status === 0 && advisories.length > 0) {
    throw new AuditPolicyError(
      "yarn npm audit exited with status 0 while reporting advisories",
    );
  }
}

function appendSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (typeof summaryPath === "string" && summaryPath !== "") {
    appendFileSync(summaryPath, markdown, "utf8");
  }
}

function renderErrorSummary(error) {
  return [
    "## Dependency Audit exception gate (yarn)",
    "",
    "The gate failed closed before an exception could be applied.",
    "",
    `- Error: ${escapeMarkdown(error.message)}`,
    "",
  ].join("\n");
}

async function main() {
  try {
    // 環境変数名は YARN_ prefix を避ける。Yarn Berry は YARN_* を設定値として
    // 解釈するため、YARN_AUDIT_EXCEPTIONS だと yarn npm audit 自体が
    // "Unrecognized or legacy configuration settings found: auditExceptions"
    // の Usage Error で失敗する
    const exceptions = parseExceptions(
      process.env.IDP_YARN_AUDIT_EXCEPTIONS ?? "[]",
      new Date(),
      EXCEPTIONS_INPUT_NAME,
    );
    if (exceptions.length === 0) {
      throw new AuditPolicyError(
        "The exception evaluator requires at least one configured exception",
      );
    }

    const { advisories, status } = runYarnAudit();
    assertYarnAuditConsistency(advisories, status);

    const result = evaluateYarnAudit(advisories, exceptions);
    const summary = renderYarnSummary(exceptions, result);
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
