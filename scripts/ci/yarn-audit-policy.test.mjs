import assert from "node:assert/strict";
import test from "node:test";

import { AuditPolicyError, parseExceptions } from "./npm-audit-policy.mjs";
import {
  YARN_AUDIT_ARGS,
  assertYarnAuditConsistency,
  evaluateYarnAudit,
  parseYarnAuditOutput,
  renderYarnSummary,
} from "./yarn-audit-policy.mjs";

const NOW = new Date("2026-08-05T12:00:00.000Z");
const GHSA = "GHSA-mh99-v99m-4gvg";
const OTHER_GHSA = "GHSA-2222-3333-4444";

function activeException(overrides = {}) {
  return {
    id: GHSA,
    expires: "2026-11-02",
    tracking: "https://github.com/kmryst/idp-golden-path/issues/134",
    ...overrides,
  };
}

function auditLine(overrides = {}) {
  const children = {
    ID: 1130588,
    Issue: "brace-expansion Regular Expression Denial of Service",
    URL: `https://github.com/advisories/${GHSA}`,
    Severity: "high",
    "Vulnerable Versions": "<1.1.17",
    "Tree Versions": ["1.1.15"],
    Dependents: ["minimatch@npm:3.1.5"],
    ...overrides.children,
  };
  return JSON.stringify({
    value: overrides.value ?? "brace-expansion",
    children,
  });
}

function ndjson(...lines) {
  return `${lines.join("\n")}\n`;
}

test("audit command audits the full workspace graph as JSON", () => {
  assert.deepEqual(YARN_AUDIT_ARGS, [
    "npm",
    "audit",
    "--all",
    "--recursive",
    "--json",
  ]);
});

test("parses NDJSON advisory lines and maps canonical GHSA IDs", () => {
  const advisories = parseYarnAuditOutput(ndjson(auditLine()));

  assert.equal(advisories.length, 1);
  assert.equal(advisories[0].package, "brace-expansion");
  assert.equal(advisories[0].ghsa, GHSA);
  assert.equal(advisories[0].severity, "high");
  assert.equal(advisories[0].advisoryId, "1130588");
});

test("parses empty audit output as an empty advisory list", () => {
  assert.deepEqual(parseYarnAuditOutput(""), []);
  assert.deepEqual(parseYarnAuditOutput("\n"), []);
});

test("does not map a GHSA token embedded in a non-canonical advisory URL", () => {
  const advisories = parseYarnAuditOutput(
    ndjson(
      auditLine({
        children: {
          URL: `https://registry.example.invalid/advisory?alias=${GHSA}`,
        },
      }),
    ),
  );

  assert.equal(advisories[0].ghsa, null);
});

test("fails closed on malformed audit output", async (t) => {
  const invalidCases = [
    {
      name: "non-JSON line",
      raw: "yarn npm audit failed",
      message: /is not valid JSON/,
    },
    {
      name: "missing package name",
      raw: ndjson(JSON.stringify({ children: { Severity: "high", ID: 1 } })),
      message: /missing the affected package name/,
    },
    {
      name: "missing advisory details",
      raw: ndjson(JSON.stringify({ value: "left-pad" })),
      message: /missing advisory details/,
    },
    {
      name: "missing severity",
      raw: ndjson(auditLine({ children: { Severity: undefined } })),
      message: /missing a severity/,
    },
    {
      name: "unknown severity",
      raw: ndjson(auditLine({ children: { Severity: "catastrophic" } })),
      message: /unknown severity/,
    },
    {
      name: "missing advisory ID",
      raw: ndjson(auditLine({ children: { ID: undefined } })),
      message: /missing the advisory ID/,
    },
  ];

  for (const invalidCase of invalidCases) {
    await t.test(invalidCase.name, () => {
      assert.throws(
        () => parseYarnAuditOutput(invalidCase.raw),
        invalidCase.message,
      );
    });
  }
});

test("allows one exact GHSA across multiple advisories, majors, and packages", () => {
  const advisories = parseYarnAuditOutput(
    ndjson(
      auditLine(),
      auditLine({
        children: {
          ID: 1130589,
          "Vulnerable Versions": ">=2.0.0 <2.1.3",
          "Tree Versions": ["2.1.1"],
          Dependents: ["minimatch@npm:5.1.9"],
        },
      }),
      auditLine({
        value: "minimatch",
        children: { ID: 1130591 },
      }),
    ),
  );
  const result = evaluateYarnAudit(advisories, [activeException()]);

  assert.equal(result.pass, true);
  assert.equal(result.allowed.length, 1);
  assert.equal(result.allowed[0].id, GHSA);
  assert.deepEqual(result.allowed[0].packages, ["brace-expansion", "minimatch"]);
  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.unused, []);
});

test("blocks another High advisory mixed with the allowed GHSA", () => {
  const advisories = parseYarnAuditOutput(
    ndjson(
      auditLine(),
      auditLine({
        value: "unsafe-package",
        children: {
          ID: 999,
          URL: `https://github.com/advisories/${OTHER_GHSA}`,
        },
      }),
    ),
  );
  const result = evaluateYarnAudit(advisories, [activeException()]);

  assert.equal(result.pass, false);
  assert.equal(result.allowed.length, 1);
  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0].id, OTHER_GHSA);
  assert.match(result.blocked[0].reason, /not in the active exception list/);
});

test("blocks a High advisory without a canonical GHSA ID", () => {
  const advisories = parseYarnAuditOutput(
    ndjson(auditLine({ children: { URL: undefined } })),
  );
  const result = evaluateYarnAudit(advisories, [activeException()]);

  assert.equal(result.pass, false);
  assert.equal(result.blocked[0].id, null);
  assert.match(result.blocked[0].reason, /no GHSA ID/);
});

test("blocks Critical even when the same GHSA is configured", () => {
  const advisories = parseYarnAuditOutput(
    ndjson(auditLine({ children: { Severity: "critical" } })),
  );
  const result = evaluateYarnAudit(advisories, [activeException()]);

  assert.equal(result.pass, false);
  assert.match(result.blocked[0].reason, /Critical advisories cannot be excepted/);
});

test("combines the same GHSA across High and Critical packages as Critical", () => {
  const advisories = parseYarnAuditOutput(
    ndjson(
      auditLine({ value: "high-package" }),
      auditLine({ value: "critical-package", children: { Severity: "critical" } }),
    ),
  );
  const result = evaluateYarnAudit(advisories, [activeException()]);

  assert.equal(result.pass, false);
  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0].severity, "critical");
  assert.deepEqual(result.blocked[0].packages, [
    "critical-package",
    "high-package",
  ]);
});

test("ignores advisories below the High threshold", () => {
  const advisories = parseYarnAuditOutput(
    ndjson(
      auditLine({ children: { Severity: "moderate" } }),
      auditLine({ children: { Severity: "low", ID: 2 } }),
    ),
  );
  const result = evaluateYarnAudit(advisories, [activeException()]);

  assert.equal(result.pass, true);
  assert.deepEqual(result.allowed, []);
  assert.deepEqual(result.unused, [activeException()]);
});

test("marks a configured but no longer detected exception as a warning", () => {
  const exceptions = [activeException()];
  const result = evaluateYarnAudit([], exceptions);
  const summary = renderYarnSummary(exceptions, result);

  assert.equal(result.pass, true);
  assert.deepEqual(result.unused, exceptions);
  assert.match(summary, /not detected \(remove the stale exception\)/);
  assert.match(summary, /\[!WARNING\]/);
});

test("summary lists blocking advisories with their packages", () => {
  const advisories = parseYarnAuditOutput(
    ndjson(
      auditLine({
        value: "unsafe-package",
        children: {
          ID: 999,
          URL: `https://github.com/advisories/${OTHER_GHSA}`,
        },
      }),
    ),
  );
  const exceptions = [activeException()];
  const result = evaluateYarnAudit(advisories, exceptions);
  const summary = renderYarnSummary(exceptions, result);

  assert.match(summary, /### Blocking advisories/);
  assert.match(summary, /GHSA-2222-3333-4444 \(high\)/);
  assert.match(summary, /unsafe-package/);
});

test("fails closed when the exit status contradicts the reported advisories", () => {
  assert.throws(
    () => assertYarnAuditConsistency([], 1),
    /status 1 without reporting advisories/,
  );
  assert.throws(
    () =>
      assertYarnAuditConsistency(
        parseYarnAuditOutput(ndjson(auditLine())),
        0,
      ),
    /status 0 while reporting advisories/,
  );
  assert.doesNotThrow(() => assertYarnAuditConsistency([], 0));
  assert.doesNotThrow(() =>
    assertYarnAuditConsistency(parseYarnAuditOutput(ndjson(auditLine())), 1),
  );
});

test("exception validation reports the yarn input name", () => {
  assert.throws(
    () => parseExceptions("{", NOW, "yarn-audit-exceptions"),
    (error) =>
      error instanceof AuditPolicyError &&
      /yarn-audit-exceptions must be valid JSON/.test(error.message),
  );
  assert.throws(
    () =>
      parseExceptions(
        JSON.stringify([activeException({ expires: "2026-08-04" })]),
        NOW,
        "yarn-audit-exceptions",
      ),
    /yarn-audit-exceptions\[0\]\.expires .* before the current UTC date/,
  );
});

test("exception expiry stays within the 90-day maximum from evaluation time", () => {
  assert.deepEqual(
    parseExceptions(
      JSON.stringify([activeException({ expires: "2026-11-03" })]),
      NOW,
      "yarn-audit-exceptions",
    ),
    [activeException({ expires: "2026-11-03" })],
  );
  assert.throws(
    () =>
      parseExceptions(
        JSON.stringify([activeException({ expires: "2026-11-04" })]),
        NOW,
        "yarn-audit-exceptions",
      ),
    /exceeds the 90-day maximum/,
  );
});
