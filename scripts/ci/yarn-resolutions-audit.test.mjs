import assert from "node:assert/strict";
import test from "node:test";

import { AuditPolicyError } from "./npm-audit-policy.mjs";
import {
  checkSync,
  evaluateStaleness,
  parseResolutionsRegistry,
  renderResolutionsSummary,
} from "./yarn-resolutions-audit.mjs";

const GHSA = "GHSA-4cwx-7wf7-3272";
const OTHER_GHSA = "GHSA-52cp-r559-cp3m";

function registryEntry(overrides = {}) {
  return {
    pattern: "undici@npm:7.28.0",
    resolution: "^7.29.0",
    advisories: [GHSA],
    dependents: ["@module-federation/dts-plugin@npm:2.6.0"],
    reason: "exact pin keeps resolving a vulnerable version",
    ...overrides,
  };
}

function advisory(overrides = {}) {
  return {
    package: "undici",
    advisoryId: "1130717",
    ghsa: GHSA,
    severity: "high",
    title: "undici is vulnerable",
    ...overrides,
  };
}

test("parses a canonical registry entry", () => {
  const entry = registryEntry();
  assert.deepEqual(parseResolutionsRegistry(JSON.stringify([entry])), [entry]);
});

test("parses empty registry input as an empty list", () => {
  assert.deepEqual(parseResolutionsRegistry(""), []);
  assert.deepEqual(parseResolutionsRegistry("[]"), []);
});

test("rejects malformed registry entries", async (t) => {
  const invalidCases = [
    { name: "non-array", raw: "{}", message: /must be a JSON array/ },
    { name: "invalid JSON", raw: "{", message: /must be valid JSON/ },
    {
      name: "unknown field",
      raw: JSON.stringify([{ ...registryEntry(), expires: "2026-11-02" }]),
      message: /exactly pattern, resolution, advisories, dependents, and reason/,
    },
    {
      name: "unscoped pattern",
      raw: JSON.stringify([registryEntry({ pattern: "undici" })]),
      message: /pattern must be a scoped resolutions key/,
    },
    {
      name: "duplicate pattern",
      raw: JSON.stringify([registryEntry(), registryEntry()]),
      message: /duplicates/,
    },
    {
      name: "empty resolution",
      raw: JSON.stringify([registryEntry({ resolution: " " })]),
      message: /resolution must be a non-empty range/,
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
        () => parseResolutionsRegistry(invalidCase.raw),
        invalidCase.message,
      );
    });
  }
});

test("sync passes when every registry entry matches package.json resolutions", () => {
  const result = checkSync([registryEntry()], {
    "undici@npm:7.28.0": "^7.29.0",
    protobufjs: "^7.6.5",
  });
  assert.deepEqual(result, { pass: true, problems: [] });
});

test("sync fails on a missing or mismatching package.json resolution", () => {
  const missing = checkSync([registryEntry()], { protobufjs: "^7.6.5" });
  assert.equal(missing.pass, false);
  assert.match(missing.problems[0], /missing from package.json resolutions/);

  const mismatch = checkSync([registryEntry()], {
    "undici@npm:7.28.0": "7.29.0",
  });
  assert.equal(mismatch.pass, false);
  assert.match(mismatch.problems[0], /resolves to 7.29.0 in package.json/);
});

test("sync tolerates unmanaged resolutions in package.json", () => {
  const result = checkSync([], { "@types/react": "^18" });
  assert.equal(result.pass, true);
});

test("sync fails closed on a malformed resolutions object", () => {
  assert.throws(
    () => checkSync([registryEntry()], "not-an-object"),
    (error) =>
      error instanceof AuditPolicyError &&
      /resolutions must be an object/.test(error.message),
  );
});

test("keeps a resolution whose advisory reappears without it", () => {
  const result = evaluateStaleness([registryEntry()], [advisory()]);

  assert.equal(result.pass, true);
  assert.equal(result.needed.length, 1);
  assert.deepEqual(result.needed[0].reappeared, [GHSA]);
  assert.deepEqual(result.stale, []);
  assert.deepEqual(result.unrecorded, []);
});

test("fails when a resolution's advisories no longer reappear", () => {
  const result = evaluateStaleness([registryEntry()], []);

  assert.equal(result.pass, false);
  assert.deepEqual(result.needed, []);
  assert.equal(result.stale.length, 1);
  assert.equal(result.stale[0].pattern, "undici@npm:7.28.0");
});

test("evaluates mixed needed and stale entries independently", () => {
  const staleEntry = registryEntry({
    pattern: "js-yaml@npm:=4.2.0",
    resolution: "^4.3.0",
    advisories: [OTHER_GHSA],
    dependents: ["swagger-ui-react@npm:5.32.8"],
  });
  const result = evaluateStaleness(
    [registryEntry(), staleEntry],
    [advisory()],
  );

  assert.equal(result.pass, false);
  assert.equal(result.needed.length, 1);
  assert.equal(result.stale.length, 1);
  assert.equal(result.stale[0].pattern, "js-yaml@npm:=4.2.0");
});

test("warns about unrecorded High advisories on managed packages without failing", () => {
  const unrecorded = advisory({
    ghsa: "GHSA-aaaa-bbbb-cccc",
    advisoryId: "999",
  });
  const result = evaluateStaleness([registryEntry()], [advisory(), unrecorded]);

  assert.equal(result.pass, true);
  assert.deepEqual(result.unrecorded, [unrecorded]);

  const summary = renderResolutionsSummary(result);
  assert.match(summary, /\[!WARNING\]/);
  assert.match(summary, /GHSA-aaaa-bbbb-cccc/);
});

test("ignores advisories on unmanaged packages and below the High threshold", () => {
  const result = evaluateStaleness(
    [registryEntry()],
    [
      advisory(),
      advisory({ package: "left-pad", ghsa: "GHSA-dddd-eeee-ffff" }),
      advisory({
        severity: "moderate",
        ghsa: "GHSA-1111-2222-3333",
        advisoryId: "1000",
      }),
    ],
  );

  assert.equal(result.pass, true);
  assert.deepEqual(result.unrecorded, []);
});

test("summary marks stale entries with a removal instruction", () => {
  const result = evaluateStaleness([registryEntry()], []);
  const summary = renderResolutionsSummary(result);

  assert.match(summary, /blocked \(stale resolutions found\)/);
  assert.match(summary, /stale: remove this resolution and its registry entry/);
});
