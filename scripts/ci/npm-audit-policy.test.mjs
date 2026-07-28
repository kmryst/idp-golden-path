import assert from "node:assert/strict";
import test from "node:test";

import {
  AuditPolicyError,
  NPM_FULL_AUDIT_ARGS,
  NPM_RUNTIME_AUDIT_ARGS,
  assertRuntimeAuditPassed,
  evaluateAuditReport,
  parseAuditJson,
  parseExceptions,
  renderSummary,
} from "./npm-audit-policy.mjs";

const NOW = new Date("2026-07-28T12:00:00.000Z");
const GHSA = "GHSA-mh99-v99m-4gvg";
const OTHER_GHSA = "GHSA-2222-3333-4444";

function activeException(overrides = {}) {
  return {
    id: GHSA,
    expires: "2026-10-26",
    tracking:
      "https://github.com/kmryst/ticket-c2c-platform/issues/999",
    ...overrides,
  };
}

function advisory(id = GHSA, severity = "high") {
  return {
    source: 123456,
    name: "brace-expansion",
    dependency: "brace-expansion",
    title: "Regular Expression Denial of Service",
    url: `https://github.com/advisories/${id}`,
    severity,
    range: "<=2.0.1",
  };
}

function report(vulnerabilities, counts = {}) {
  const entries = Object.values(vulnerabilities);
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: entries.filter((entry) => entry.severity === "high").length,
        critical: entries.filter((entry) => entry.severity === "critical")
          .length,
        total: entries.length,
        ...counts,
      },
    },
  };
}

function allowedViaChainReport() {
  return report({
    "brace-expansion": {
      name: "brace-expansion",
      severity: "high",
      isDirect: false,
      via: [advisory()],
      effects: ["minimatch"],
      range: "<=2.0.1",
      nodes: [
        "node_modules/brace-expansion",
        "node_modules/test-exclude/node_modules/brace-expansion",
      ],
      fixAvailable: false,
    },
    minimatch: {
      name: "minimatch",
      severity: "high",
      isDirect: false,
      via: ["brace-expansion"],
      effects: ["glob"],
      range: "<=9.0.5",
      nodes: ["node_modules/minimatch"],
      fixAvailable: false,
    },
    glob: {
      name: "glob",
      severity: "high",
      isDirect: false,
      via: ["minimatch"],
      effects: ["jest"],
      range: "<=10.4.5",
      nodes: ["node_modules/glob"],
      fixAvailable: false,
    },
    jest: {
      name: "jest",
      severity: "high",
      isDirect: true,
      via: ["glob"],
      effects: [],
      range: "*",
      nodes: ["node_modules/jest"],
      fixAvailable: false,
    },
  });
}

test("empty exception input preserves an empty policy", () => {
  assert.deepEqual(parseExceptions("", NOW), []);
  assert.deepEqual(parseExceptions("[]", NOW), []);
});

test("audit commands explicitly control dependency classes", () => {
  assert.deepEqual(NPM_RUNTIME_AUDIT_ARGS, [
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
  assert.deepEqual(NPM_FULL_AUDIT_ARGS, [
    "audit",
    "--package-lock=true",
    "--package-lock-only=true",
    "--include=prod",
    "--include=dev",
    "--include=optional",
    "--include=peer",
    "--json",
  ]);
});

test("parses a canonical active exception and treats the expiry date as inclusive", () => {
  const entry = activeException({ expires: "2026-07-28" });
  assert.deepEqual(parseExceptions(JSON.stringify([entry]), NOW), [entry]);
});

test("rejects malformed, duplicate, expired, and non-Issue exceptions", async (t) => {
  const invalidCases = [
    {
      name: "non-array",
      raw: "{}",
      message: /must be a JSON array/,
    },
    {
      name: "unknown field",
      raw: JSON.stringify([{ ...activeException(), reason: "temporary" }]),
      message: /exactly id, expires, and tracking/,
    },
    {
      name: "non-canonical GHSA",
      raw: JSON.stringify([activeException({ id: GHSA.toLowerCase() })]),
      message: /canonical GHSA ID/,
    },
    {
      name: "invalid calendar date",
      raw: JSON.stringify([activeException({ expires: "2026-02-30" })]),
      message: /valid calendar date/,
    },
    {
      name: "expired",
      raw: JSON.stringify([activeException({ expires: "2026-07-27" })]),
      message: /before the current UTC date/,
    },
    {
      name: "longer than 90 days",
      raw: JSON.stringify([activeException({ expires: "2026-10-27" })]),
      message: /exceeds the 90-day maximum/,
    },
    {
      name: "tracking PR instead of Issue",
      raw: JSON.stringify([
        activeException({
          tracking:
            "https://github.com/kmryst/ticket-c2c-platform/pull/999",
        }),
      ]),
      message: /GitHub Issue URL/,
    },
    {
      name: "tracking URL with Markdown delimiter",
      raw: JSON.stringify([
        activeException({
          tracking:
            "https://github.com/kmryst/ticket-c2c-platform|oops/issues/999",
        }),
      ]),
      message: /GitHub Issue URL/,
    },
    {
      name: "tracking URL with closing parenthesis",
      raw: JSON.stringify([
        activeException({
          tracking:
            "https://github.com/kmryst/ticket-c2c-platform)/issues/999",
        }),
      ]),
      message: /GitHub Issue URL/,
    },
    {
      name: "duplicate",
      raw: JSON.stringify([activeException(), activeException()]),
      message: /duplicates/,
    },
  ];

  for (const invalidCase of invalidCases) {
    await t.test(invalidCase.name, () => {
      assert.throws(
        () => parseExceptions(invalidCase.raw, NOW),
        invalidCase.message,
      );
    });
  }
});

test("allows one exact GHSA across via parents and multiple installed nodes", () => {
  const exceptions = [activeException()];
  const result = evaluateAuditReport(allowedViaChainReport(), exceptions);

  assert.equal(result.pass, true);
  assert.equal(result.allowed.length, 1);
  assert.equal(result.allowed[0].id, GHSA);
  assert.deepEqual(result.allowed[0].packages, [
    "brace-expansion",
    "glob",
    "jest",
    "minimatch",
  ]);
  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.unused, []);
});

test("blocks another High advisory mixed with the allowed GHSA", () => {
  const mixedReport = allowedViaChainReport();
  mixedReport.vulnerabilities["unsafe-package"] = {
    name: "unsafe-package",
    severity: "high",
    isDirect: false,
    via: [advisory(OTHER_GHSA)],
    effects: [],
    range: "*",
    nodes: ["node_modules/unsafe-package"],
    fixAvailable: false,
  };
  mixedReport.metadata.vulnerabilities.high += 1;
  mixedReport.metadata.vulnerabilities.total += 1;

  const result = evaluateAuditReport(mixedReport, [activeException()]);
  assert.equal(result.pass, false);
  assert.equal(result.allowed.length, 1);
  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0].id, OTHER_GHSA);
});

test("does not allow a GHSA token embedded in a non-canonical advisory URL", () => {
  const spoofedReport = report({
    "unsafe-package": {
      name: "unsafe-package",
      severity: "high",
      via: [
        {
          ...advisory(),
          url: `https://registry.example.invalid/advisory?alias=${GHSA}`,
        },
      ],
    },
  });

  const result = evaluateAuditReport(spoofedReport, [activeException()]);
  assert.equal(result.pass, false);
  assert.equal(result.blocked[0].id, null);
  assert.match(result.blocked[0].reason, /no GHSA ID/);
});

test("blocks Critical even when the same GHSA is configured", () => {
  const criticalReport = report({
    "brace-expansion": {
      name: "brace-expansion",
      severity: "critical",
      via: [advisory(GHSA, "critical")],
    },
  });

  const result = evaluateAuditReport(criticalReport, [activeException()]);
  assert.equal(result.pass, false);
  assert.match(result.blocked[0].reason, /Critical advisories cannot be excepted/);
});

test("combines the same GHSA across High and Critical packages as Critical", () => {
  const mixedSeverityReport = report({
    "high-package": {
      name: "high-package",
      severity: "high",
      via: [advisory(GHSA, "high")],
    },
    "critical-package": {
      name: "critical-package",
      severity: "critical",
      via: [advisory(GHSA, "critical")],
    },
  });

  const result = evaluateAuditReport(mixedSeverityReport, [activeException()]);
  assert.equal(result.pass, false);
  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0].severity, "critical");
  assert.deepEqual(result.blocked[0].packages, [
    "critical-package",
    "high-package",
  ]);
});

test("blocks the configured GHSA when it appears in runtime dependencies", () => {
  const runtimeReport = report({
    "brace-expansion": {
      name: "brace-expansion",
      severity: "high",
      via: [advisory()],
    },
  });

  assert.throws(
    () => assertRuntimeAuditPassed(runtimeReport, 1),
    /Runtime dependencies contain a High or Critical vulnerability/,
  );
});

test("fails closed when runtime metadata hides a High entry", () => {
  const inconsistentRuntimeReport = report(
    {
      "unsafe-package": {
        name: "unsafe-package",
        severity: "high",
        via: [advisory()],
      },
    },
    { high: 0, total: 0 },
  );

  assert.throws(
    () => assertRuntimeAuditPassed(inconsistentRuntimeReport, 0),
    /high count does not match vulnerability entries/,
  );
});

test("fails closed when a High via chain has no root advisory", () => {
  const unresolvedReport = report({
    parent: {
      name: "parent",
      severity: "high",
      via: ["missing-child"],
    },
  });

  assert.throws(
    () => evaluateAuditReport(unresolvedReport, [activeException()]),
    /without a valid vulnerability entry/,
  );
});

test("fails closed when a via chain contains a cycle", () => {
  const cyclicReport = report({
    first: {
      name: "first",
      severity: "high",
      via: ["second"],
    },
    second: {
      name: "second",
      severity: "high",
      via: ["first"],
    },
  });

  assert.throws(
    () => evaluateAuditReport(cyclicReport, [activeException()]),
    /via chain contains a cycle/,
  );
});

test("fails closed when a High package resolves only to a Moderate advisory", () => {
  const inconsistentReport = report({
    parent: {
      name: "parent",
      severity: "high",
      via: [advisory(GHSA, "moderate")],
    },
  });

  assert.throws(
    () => evaluateAuditReport(inconsistentReport, [activeException()]),
    /could not resolve a High or Critical root advisory/,
  );
});

test("fails closed on an unexpected audit schema or npm error document", () => {
  assert.throws(
    () => parseAuditJson('{"metadata":{}}'),
    /missing vulnerabilities/,
  );
  assert.throws(
    () =>
      parseAuditJson(
        '{"error":{"code":"ENOAUDIT","summary":"registry unavailable"}}',
      ),
    /returned an error \(ENOAUDIT\)/,
  );
  assert.throws(
    () => parseAuditJson("npm WARN registry unavailable"),
    /did not return valid JSON/,
  );
});

test("marks a configured but no longer detected exception as a warning", () => {
  const cleanReport = report({});
  const exceptions = [activeException()];
  const result = evaluateAuditReport(cleanReport, exceptions);
  const summary = renderSummary(exceptions, result);

  assert.equal(result.pass, true);
  assert.deepEqual(result.unused, exceptions);
  assert.match(summary, /not detected \(remove the stale exception\)/);
  assert.match(summary, /\[!WARNING\]/);
});

test("fails closed when metadata reports threshold findings without entries", () => {
  const inconsistentReport = report({}, { high: 1, total: 1 });
  assert.throws(
    () => evaluateAuditReport(inconsistentReport, [activeException()]),
    /high count does not match vulnerability entries/,
  );
});

test("fails closed when metadata undercounts threshold entries", () => {
  const inconsistentReport = allowedViaChainReport();
  inconsistentReport.metadata.vulnerabilities.high -= 1;
  assert.throws(
    () => evaluateAuditReport(inconsistentReport, [activeException()]),
    /high count does not match vulnerability entries/,
  );
});

test("AuditPolicyError remains distinguishable for CLI fail-closed handling", () => {
  assert.throws(
    () => parseExceptions("{", NOW),
    (error) =>
      error instanceof AuditPolicyError &&
      /must be valid JSON/.test(error.message),
  );
});
