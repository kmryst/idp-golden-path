import assert from "node:assert/strict";
import test from "node:test";

import { AuditPolicyError } from "./npm-audit-policy.mjs";
import {
  NPM_PROJECT_DIRECTORIES,
  checkSync,
  evaluateStaleness,
  extractAdvisories,
  parseNonSecurityOverrides,
  parseOverridesRegistry,
  renderOverridesSummary,
} from "./npm-overrides-audit.mjs";

const GHSA = "GHSA-7w5x-hrqm-74c2";
const OTHER_GHSA = "GHSA-4cwx-7wf7-3272";
const ROOT = ".";
const SKELETON = "backstage/templates/service-baseline/skeleton";

function registryEntry(overrides = {}) {
  return {
    pattern: "smol-toml",
    override: "^1.8.0",
    directories: [ROOT, SKELETON],
    advisories: [GHSA],
    dependents: ["markdownlint-cli2@0.23.2"],
    reason: "exact pin keeps resolving a vulnerable version",
    ...overrides,
  };
}

function nonSecurityEntry(overrides = {}) {
  return {
    pattern: "@types/node",
    directories: [ROOT],
    reason: "型定義のバージョン統一。advisory 回避ではない",
    ...overrides,
  };
}

function advisory(overrides = {}) {
  return {
    package: "smol-toml",
    ghsa: GHSA,
    severity: "high",
    title: "smol-toml is vulnerable",
    ...overrides,
  };
}

function auditReport(vulnerabilities) {
  return { vulnerabilities };
}

test("NPM_PROJECT_DIRECTORIES covers the audited npm projects", () => {
  assert.deepEqual([...NPM_PROJECT_DIRECTORIES], [ROOT, SKELETON]);
});

test("parses a canonical registry entry", () => {
  const entry = registryEntry();
  assert.deepEqual(parseOverridesRegistry(JSON.stringify([entry])), [entry]);
});

test("parses empty registry input as an empty list", () => {
  assert.deepEqual(parseOverridesRegistry(""), []);
  assert.deepEqual(parseOverridesRegistry("[]"), []);
});

test("rejects malformed registry entries", async (t) => {
  const invalidCases = [
    { name: "non-array", raw: "{}", message: /must be a JSON array/ },
    { name: "invalid JSON", raw: "{", message: /must be valid JSON/ },
    {
      name: "unknown field",
      raw: JSON.stringify([{ ...registryEntry(), expires: "2026-11-02" }]),
      message:
        /exactly pattern, override, directories, advisories, dependents, and reason/,
    },
    {
      name: "range-scoped pattern",
      raw: JSON.stringify([registryEntry({ pattern: "smol-toml@1.7.0" })]),
      message: /pattern must be an npm package name/,
    },
    {
      name: "duplicate pattern",
      raw: JSON.stringify([registryEntry(), registryEntry()]),
      message: /duplicates/,
    },
    {
      name: "empty override",
      raw: JSON.stringify([registryEntry({ override: " " })]),
      message: /override must be a non-empty range/,
    },
    {
      name: "empty directories",
      raw: JSON.stringify([registryEntry({ directories: [] })]),
      message: /non-empty array of npm project directories/,
    },
    {
      name: "duplicate directories",
      raw: JSON.stringify([registryEntry({ directories: [ROOT, ROOT] })]),
      message: /directories contains duplicates/,
    },
    {
      name: "unknown directory",
      raw: JSON.stringify([registryEntry({ directories: ["terraform"] })]),
      message: /unknown npm project directory/,
    },
    {
      name: "empty advisories",
      raw: JSON.stringify([registryEntry({ advisories: [] })]),
      message: /non-empty array of canonical GHSA IDs/,
    },
    {
      name: "non-canonical GHSA",
      raw: JSON.stringify([registryEntry({ advisories: ["CVE-2026-1234"] })]),
      message: /canonical GHSA IDs/,
    },
    {
      name: "duplicate advisories",
      raw: JSON.stringify([registryEntry({ advisories: [GHSA, GHSA] })]),
      message: /contains duplicates/,
    },
    {
      name: "empty dependents",
      raw: JSON.stringify([registryEntry({ dependents: [] })]),
      message: /non-empty array of package locators/,
    },
    {
      name: "empty reason",
      raw: JSON.stringify([registryEntry({ reason: "" })]),
      message: /reason must be a non-empty string/,
    },
  ];

  for (const invalidCase of invalidCases) {
    await t.test(invalidCase.name, () => {
      assert.throws(
        () => parseOverridesRegistry(invalidCase.raw),
        invalidCase.message,
      );
    });
  }
});

test("parses a canonical non-security declaration", () => {
  const entry = nonSecurityEntry();
  assert.deepEqual(parseNonSecurityOverrides(JSON.stringify([entry])), [entry]);
});

test("parses empty non-security input as an empty list", () => {
  assert.deepEqual(parseNonSecurityOverrides(""), []);
  assert.deepEqual(parseNonSecurityOverrides("[]"), []);
});

test("rejects malformed non-security declarations", async (t) => {
  const invalidCases = [
    { name: "non-array", raw: "{}", message: /must be a JSON array/ },
    { name: "invalid JSON", raw: "{", message: /must be valid JSON/ },
    {
      name: "unknown field",
      raw: JSON.stringify([{ ...nonSecurityEntry(), advisories: [GHSA] }]),
      message: /must contain exactly pattern, directories, and reason/,
    },
    {
      name: "empty pattern",
      raw: JSON.stringify([nonSecurityEntry({ pattern: " " })]),
      message: /pattern must be a non-empty string/,
    },
    {
      name: "duplicate pattern",
      raw: JSON.stringify([nonSecurityEntry(), nonSecurityEntry()]),
      message: /duplicates/,
    },
    {
      name: "unknown directory",
      raw: JSON.stringify([nonSecurityEntry({ directories: ["docs"] })]),
      message: /unknown npm project directory/,
    },
    {
      name: "empty reason",
      raw: JSON.stringify([nonSecurityEntry({ reason: "" })]),
      message: /reason must be a non-empty string/,
    },
  ];

  for (const invalidCase of invalidCases) {
    await t.test(invalidCase.name, () => {
      assert.throws(
        () => parseNonSecurityOverrides(invalidCase.raw),
        invalidCase.message,
      );
    });
  }
});

test("sync passes when every override in every directory is declared", () => {
  const result = checkSync(
    [registryEntry()],
    {
      [ROOT]: { "smol-toml": "^1.8.0", "@types/node": "^24" },
      [SKELETON]: { "smol-toml": "^1.8.0" },
    },
    [nonSecurityEntry()],
  );
  assert.deepEqual(result, { pass: true, problems: [] });
});

test("sync fails on a missing or mismatching override", () => {
  const missing = checkSync([registryEntry()], {
    [ROOT]: {},
    [SKELETON]: { "smol-toml": "^1.8.0" },
  });
  assert.equal(missing.pass, false);
  assert.match(missing.problems[0], /^\.: smol-toml is registered .* missing/);

  const mismatched = checkSync([registryEntry()], {
    [ROOT]: { "smol-toml": "1.8.0" },
    [SKELETON]: { "smol-toml": "^1.8.0" },
  });
  assert.equal(mismatched.pass, false);
  assert.match(
    mismatched.problems[0],
    /overrides to 1\.8\.0 in package\.json but \^1\.8\.0/,
  );
});

test("sync fails on an override declared in neither file", () => {
  const result = checkSync([registryEntry()], {
    [ROOT]: { "smol-toml": "^1.8.0", tar: "^7.5.7" },
    [SKELETON]: { "smol-toml": "^1.8.0" },
  });
  assert.equal(result.pass, false);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /tar is present in package\.json overrides/);
});

test("sync fails when a pattern is declared in both files", () => {
  const result = checkSync(
    [registryEntry()],
    { [ROOT]: { "smol-toml": "^1.8.0" } },
    [nonSecurityEntry({ pattern: "smol-toml" })],
  );
  assert.equal(result.pass, false);
  assert.match(result.problems[0], /declared in both/);
});

test("sync fails when a non-security declaration has no matching override", () => {
  const result = checkSync([], { [ROOT]: {} }, [nonSecurityEntry()]);
  assert.equal(result.pass, false);
  assert.match(result.problems[0], /missing from package\.json overrides/);
});

test("sync rejects nested override objects", () => {
  const result = checkSync([registryEntry()], {
    [ROOT]: { "smol-toml": { "some-dep": "^1.0.0" } },
  });
  assert.equal(result.pass, false);
  assert.ok(
    result.problems.some((problem) =>
      /nested override objects are not supported/.test(problem),
    ),
  );
});

test("sync scopes each registry entry to its declared directories", () => {
  const rootOnly = registryEntry({ directories: [ROOT] });
  const result = checkSync([rootOnly], {
    [ROOT]: { "smol-toml": "^1.8.0" },
    [SKELETON]: {},
  });
  assert.deepEqual(result, { pass: true, problems: [] });
});

test("sync fails closed on a malformed overrides object", () => {
  assert.throws(
    () => checkSync([], { [ROOT]: [] }),
    (error) =>
      error instanceof AuditPolicyError && /must be an object/.test(error.message),
  );
  assert.throws(
    () => checkSync([], []),
    /must be given as a directory-keyed object/,
  );
});

test("extracts advisories from via chains at every severity", () => {
  const advisories = extractAdvisories(
    auditReport({
      "smol-toml": {
        severity: "high",
        via: [
          {
            name: "smol-toml",
            severity: "high",
            title: "smol-toml is vulnerable",
            url: `https://github.com/advisories/${GHSA}`,
          },
        ],
      },
      "markdownlint-cli2": { severity: "high", via: ["smol-toml"] },
      "some-dev-tool": {
        severity: "moderate",
        via: [
          {
            name: "some-dev-tool",
            severity: "moderate",
            title: "moderate issue",
            url: `https://github.com/advisories/${OTHER_GHSA}`,
          },
        ],
      },
    }),
  );

  assert.deepEqual(advisories, [
    advisory(),
    {
      package: "some-dev-tool",
      ghsa: OTHER_GHSA,
      severity: "moderate",
      title: "moderate issue",
    },
  ]);
});

test("deduplicates the same advisory reported through several packages", () => {
  const via = {
    name: "smol-toml",
    severity: "high",
    title: "smol-toml is vulnerable",
    url: `https://github.com/advisories/${GHSA}`,
  };
  const advisories = extractAdvisories(
    auditReport({
      "smol-toml": { severity: "high", via: [via] },
      "markdownlint-cli2": { severity: "high", via: [via] },
    }),
  );
  assert.deepEqual(advisories, [advisory()]);
});

test("extraction fails closed on malformed audit output", () => {
  assert.throws(
    () => extractAdvisories({}),
    /npm audit output is missing vulnerabilities/,
  );
  assert.throws(
    () => extractAdvisories(auditReport({ "smol-toml": { severity: "high" } })),
    /must contain a via array/,
  );
  assert.throws(
    () =>
      extractAdvisories(
        auditReport({
          "smol-toml": { severity: "high", via: [{ severity: "severe" }] },
        }),
      ),
    /unknown severity/,
  );
});

test("keeps an override whose advisory reappears without it", () => {
  const result = evaluateStaleness([registryEntry()], {
    [ROOT]: [advisory()],
    [SKELETON]: [advisory()],
  });
  assert.equal(result.pass, true);
  assert.equal(result.stale.length, 0);
  assert.deepEqual(
    result.needed.map((entry) => [entry.directory, entry.reappeared]),
    [
      [ROOT, [GHSA]],
      [SKELETON, [GHSA]],
    ],
  );
});

test("fails when an override's advisory no longer reappears", () => {
  const result = evaluateStaleness([registryEntry({ directories: [ROOT] })], {
    [ROOT]: [],
  });
  assert.equal(result.pass, false);
  assert.deepEqual(
    result.stale.map((entry) => [entry.directory, entry.pattern]),
    [[ROOT, "smol-toml"]],
  );
});

test("evaluates each directory independently", () => {
  const result = evaluateStaleness([registryEntry()], {
    [ROOT]: [advisory()],
    [SKELETON]: [],
  });
  assert.equal(result.pass, false);
  assert.deepEqual(
    result.needed.map((entry) => entry.directory),
    [ROOT],
  );
  assert.deepEqual(
    result.stale.map((entry) => entry.directory),
    [SKELETON],
  );
});

test("warns about unrecorded High advisories on managed packages without failing", () => {
  const result = evaluateStaleness([registryEntry({ directories: [ROOT] })], {
    [ROOT]: [advisory(), advisory({ ghsa: OTHER_GHSA, title: "another" })],
  });
  assert.equal(result.pass, true);
  assert.deepEqual(
    result.unrecorded.map((entry) => entry.ghsa),
    [OTHER_GHSA],
  );
});

test("ignores advisories on unmanaged packages and below the High threshold", () => {
  const result = evaluateStaleness([registryEntry({ directories: [ROOT] })], {
    [ROOT]: [
      advisory(),
      advisory({ package: "other-package", ghsa: OTHER_GHSA }),
      advisory({ ghsa: OTHER_GHSA, severity: "moderate" }),
    ],
  });
  assert.equal(result.pass, true);
  assert.deepEqual(result.unrecorded, []);
});

test("staleness fails closed on a malformed advisory collection", () => {
  assert.throws(
    () => evaluateStaleness([], []),
    /must be given as a directory-keyed object/,
  );
  assert.throws(
    () => evaluateStaleness([], { [ROOT]: "high" }),
    /must be an array/,
  );
});

test("summary marks stale entries with a removal instruction", () => {
  const summary = renderOverridesSummary(
    evaluateStaleness([registryEntry()], { [ROOT]: [advisory()], [SKELETON]: [] }),
  );
  assert.match(summary, /blocked \(stale overrides found\)/);
  assert.match(summary, /\| \. \| smol-toml \| \^1\.8\.0 \| GHSA-[^|]+\| still needed \|/);
  assert.match(summary, /remove this override and its registry entry/);
});

test("summary lists unrecorded advisories as a warning", () => {
  const summary = renderOverridesSummary(
    evaluateStaleness([registryEntry({ directories: [ROOT] })], {
      [ROOT]: [advisory(), advisory({ ghsa: OTHER_GHSA })],
    }),
  );
  assert.match(summary, /Result: passed/);
  assert.match(summary, /Unrecorded High \/ Critical advisories/);
  assert.match(summary, new RegExp(`${OTHER_GHSA} \\(high\\) on smol-toml`));
});
