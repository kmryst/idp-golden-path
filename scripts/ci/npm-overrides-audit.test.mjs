import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AuditPolicyError } from "./npm-audit-policy.mjs";
import {
  NPM_PROJECT_DIRECTORIES,
  REMOVAL_PR_TITLE,
  applyOverridesRemoval,
  authorizeOverridesRemoval,
  checkSync,
  evaluateStaleness,
  extractAdvisories,
  findIntroducedAdvisories,
  parseNonSecurityOverrides,
  parseOverridesRegistry,
  parseOverridesRemovalRequest,
  renderOverridesSummary,
  runApplyRemoval,
  selectRemovable,
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

// ---------------------------------------------------------------------------
// 撤去 PR（Issue #310、ADR-0016）
// ---------------------------------------------------------------------------

test("selects only overrides that are stale in every directory as removable", () => {
  const both = registryEntry();
  const rootOnly = registryEntry({ pattern: "ms", directories: [ROOT] });
  const split = registryEntry({ pattern: "argparse", advisories: [OTHER_GHSA] });
  const result = evaluateStaleness([both, rootOnly, split], {
    [ROOT]: [advisory({ package: "argparse", ghsa: OTHER_GHSA })],
    [SKELETON]: [],
  });
  const { removable, partial } = selectRemovable([both, rootOnly, split], result);
  assert.deepEqual(
    removable.map((entry) => entry.pattern),
    ["smol-toml", "ms"],
  );
  assert.deepEqual(partial, [
    { pattern: "argparse", staleIn: [SKELETON], neededIn: [ROOT] },
  ]);
});

test("summary announces a removal pull request only without partial staleness", () => {
  const entry = registryEntry();
  const allStale = evaluateStaleness([entry], { [ROOT]: [], [SKELETON]: [] });
  assert.match(
    renderOverridesSummary(allStale, selectRemovable([entry], allStale)),
    /removable: removal pull request will be created/,
  );
  const partial = evaluateStaleness([entry], { [ROOT]: [advisory()], [SKELETON]: [] });
  const summary = renderOverridesSummary(partial, selectRemovable([entry], partial));
  assert.match(summary, /blocked \(stale overrides found\)/);
  assert.match(summary, /smol-toml: stale in .*skeleton, still needed in \./);
});

test("parses a removal request with pattern names only", () => {
  assert.deepEqual(
    parseOverridesRemovalRequest(
      JSON.stringify({ patterns: ["smol-toml", "@scope/pkg"], lockfileChanges: false }),
    ),
    { patterns: ["smol-toml", "@scope/pkg"], lockfileChanges: false },
  );
});

test("rejects removal requests that carry anything beyond pattern names", () => {
  const cases = [
    "not json",
    JSON.stringify([]),
    JSON.stringify({ patterns: ["smol-toml"] }),
    JSON.stringify({ patterns: ["smol-toml"], lockfileChanges: false, body: "x" }),
    JSON.stringify({ patterns: [], lockfileChanges: false }),
    JSON.stringify({ patterns: ["smol-toml@1.0.0"], lockfileChanges: false }),
    JSON.stringify({ patterns: ["../package"], lockfileChanges: false }),
    JSON.stringify({ patterns: ["smol-toml", "smol-toml"], lockfileChanges: false }),
    JSON.stringify({ patterns: ["smol-toml"], lockfileChanges: "false" }),
  ];
  for (const raw of cases) {
    assert.throws(() => parseOverridesRemovalRequest(raw), AuditPolicyError, raw);
  }
});

test("authorizes only patterns registered in the security registry", () => {
  const registry = [registryEntry()];
  assert.equal(
    authorizeOverridesRemoval({ patterns: ["smol-toml"] }, registry)[0].pattern,
    "smol-toml",
  );
  assert.throws(
    () => authorizeOverridesRemoval({ patterns: ["@types/node"] }, registry),
    /not registered in npm-overrides.json/,
  );
});

test("removes overrides from every declared directory and drops an empty overrides key", () => {
  const smol = registryEntry();
  const ms = registryEntry({ pattern: "ms", override: "^2.1.3", directories: [ROOT] });
  const manifests = {
    [ROOT]: { name: "root", overrides: { "smol-toml": "^1.8.0", ms: "^2.1.3" } },
    [SKELETON]: { name: "skeleton", overrides: { "smol-toml": "^1.8.0" } },
  };
  const removed = applyOverridesRemoval(manifests, [smol, ms], [smol]);
  assert.deepEqual(removed.manifests, {
    [ROOT]: { name: "root", overrides: { ms: "^2.1.3" } },
    [SKELETON]: { name: "skeleton" },
  });
  assert.deepEqual(removed.registry, [ms]);
  // 入力は書き換えない
  assert.deepEqual(manifests[SKELETON].overrides, { "smol-toml": "^1.8.0" });
});

test("only High / Critical advisories absent before the removal count as introduced", () => {
  const baseline = [advisory({ package: "braces", ghsa: OTHER_GHSA })];
  const after = [
    advisory({ package: "braces", ghsa: OTHER_GHSA }),
    advisory({ severity: "moderate" }),
    advisory({ package: "ms", severity: "critical" }),
  ];
  assert.deepEqual(findIntroducedAdvisories(baseline, after), [`ms ${GHSA}`]);
});

function applySandbox(request, extraFiles = {}) {
  const base = mkdtempSync(join(tmpdir(), "npm-overrides-apply-"));
  const rootDir = join(base, "repo");
  mkdirSync(join(rootDir, "scripts", "ci"), { recursive: true });
  mkdirSync(join(rootDir, SKELETON), { recursive: true });
  const entry = registryEntry({ override: "2.0.1", pattern: "argparse" });
  writeFileSync(
    join(rootDir, "scripts", "ci", "npm-overrides.json"),
    `${JSON.stringify([entry], null, 2)}\n`,
  );
  for (const directory of [ROOT, SKELETON]) {
    writeFileSync(
      join(rootDir, directory, "package.json"),
      `${JSON.stringify({ name: directory, overrides: { argparse: "2.0.1" } }, null, 2)}\n`,
    );
  }
  const requestDir = join(base, "request");
  mkdirSync(requestDir);
  writeFileSync(join(requestDir, "removal.json"), JSON.stringify(request));
  for (const [name, content] of Object.entries(extraFiles)) {
    writeFileSync(join(requestDir, name), content);
  }
  return { base, rootDir, requestDir, prDir: join(base, "pr") };
}

test("apply-removal rewrites package.json and the registry and renders a Draft pull request", () => {
  const sandbox = applySandbox({ patterns: ["argparse"], lockfileChanges: true });
  try {
    runApplyRemoval({ ...sandbox, runUrl: "https://example.invalid/runs/1" });
    for (const directory of [ROOT, SKELETON]) {
      assert.equal(
        readFileSync(join(sandbox.rootDir, directory, "package.json"), "utf8"),
        `${JSON.stringify({ name: directory }, null, 2)}\n`,
      );
    }
    assert.equal(
      readFileSync(join(sandbox.rootDir, "scripts", "ci", "npm-overrides.json"), "utf8"),
      "[]\n",
    );
    const body = readFileSync(join(sandbox.prDir, "pull-request-body.md"), "utf8");
    assert.match(body, /この PR は Draft です/);
    assert.match(body, /^Refs #310$/m);
    assert.match(body, /runs\/1/);
    assert.equal(readFileSync(join(sandbox.prDir, "pull-request-draft.txt"), "utf8"), "true\n");
    assert.equal(
      readFileSync(join(sandbox.prDir, "pull-request-title.txt"), "utf8"),
      `${REMOVAL_PR_TITLE}\n`,
    );
  } finally {
    rmSync(sandbox.base, { recursive: true, force: true });
  }
});

test("apply-removal renders a ready pull request when the lockfile does not change", () => {
  const sandbox = applySandbox({ patterns: ["argparse"], lockfileChanges: false });
  try {
    runApplyRemoval(sandbox);
    const body = readFileSync(join(sandbox.prDir, "pull-request-body.md"), "utf8");
    assert.doesNotMatch(body, /Draft/);
    assert.equal(readFileSync(join(sandbox.prDir, "pull-request-draft.txt"), "utf8"), "false\n");
  } finally {
    rmSync(sandbox.base, { recursive: true, force: true });
  }
});

test("apply-removal rejects an artifact with another file or an unregistered pattern", () => {
  const cases = [
    [applySandbox({ patterns: ["argparse"], lockfileChanges: false }, { "package.json": "{}" }), /must contain only removal.json/],
    [applySandbox({ patterns: ["ms"], lockfileChanges: false }), /not registered in npm-overrides.json/],
  ];
  for (const [sandbox, pattern] of cases) {
    try {
      assert.throws(() => runApplyRemoval(sandbox), pattern);
      // 作業ツリーは書き換えない
      assert.match(
        readFileSync(join(sandbox.rootDir, ROOT, "package.json"), "utf8"),
        /"argparse": "2\.0\.1"/,
      );
    } finally {
      rmSync(sandbox.base, { recursive: true, force: true });
    }
  }
});
