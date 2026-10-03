import assert from "node:assert/strict";
import test from "node:test";

import { AuditPolicyError } from "./npm-audit-policy.mjs";
import {
  applyRemoval,
  assertProbeTargetsInLockfile,
  checkSync,
  classifyProbe,
  evaluateStaleness,
  parseNonSecurityResolutions,
  parseResolutionsRegistry,
  renderProbeSummary,
  renderRemovalPullRequestBody,
  renderResolutionsSummary,
  summarizeYarnFailure,
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

function nonSecurityEntry(overrides = {}) {
  return {
    pattern: "@types/react",
    reason: "React 18 系に型を揃えるためのバージョン統一",
    ...overrides,
  };
}

const TRACKING_URL = "https://github.com/yarnpkg/berry/issues/7281";

function probedEntry(overrides = {}) {
  return {
    pattern: "@yarnpkg/core/got",
    reason: "上流が壊れた patch 記述子のまま公開しているため npm 版に上書きする",
    probe: { up: ["@backstage/cli"] },
    tracking: TRACKING_URL,
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

test("parses a canonical non-security declaration", () => {
  const entry = nonSecurityEntry();
  assert.deepEqual(parseNonSecurityResolutions(JSON.stringify([entry])), [
    entry,
  ]);
});

test("parses empty non-security input as an empty list", () => {
  assert.deepEqual(parseNonSecurityResolutions(""), []);
  assert.deepEqual(parseNonSecurityResolutions("[]"), []);
});

test("parses a non-security declaration with probe and tracking", () => {
  const entry = probedEntry();
  assert.deepEqual(parseNonSecurityResolutions(JSON.stringify([entry])), [
    entry,
  ]);
});

test("parses probe and tracking independently of each other", () => {
  const probeOnly = probedEntry({ tracking: undefined });
  delete probeOnly.tracking;
  assert.deepEqual(parseNonSecurityResolutions(JSON.stringify([probeOnly])), [
    { pattern: probeOnly.pattern, reason: probeOnly.reason, probe: probeOnly.probe },
  ]);

  const trackingOnly = probedEntry({ probe: undefined });
  delete trackingOnly.probe;
  assert.deepEqual(
    parseNonSecurityResolutions(JSON.stringify([trackingOnly])),
    [
      {
        pattern: trackingOnly.pattern,
        reason: trackingOnly.reason,
        tracking: TRACKING_URL,
      },
    ],
  );
});

test("rejects malformed probe and tracking values", async (t) => {
  const invalidCases = [
    {
      name: "probe is not an object",
      raw: JSON.stringify([probedEntry({ probe: true })]),
      message: /probe must be an object with up/,
    },
    {
      name: "probe with an unknown key",
      raw: JSON.stringify([
        probedEntry({ probe: { up: ["@backstage/cli"], steps: ["yarn tsc"] } }),
      ]),
      message: /probe must contain exactly up/,
    },
    {
      name: "probe with empty up",
      raw: JSON.stringify([probedEntry({ probe: { up: [] } })]),
      message: /probe.up must be a non-empty array of package names/,
    },
    {
      name: "probe with a non-string up target",
      raw: JSON.stringify([probedEntry({ probe: { up: [7] } })]),
      message: /probe.up must be a non-empty array of package names/,
    },
    {
      name: "probe with a glob up target",
      raw: JSON.stringify([probedEntry({ probe: { up: ["@backstage/*"] } })]),
      message: /probe.up must be a non-empty array of package names/,
    },
    {
      name: "probe with a ranged up target",
      raw: JSON.stringify([probedEntry({ probe: { up: ["@backstage/cli@^0.36.6"] } })]),
      message: /probe.up must be a non-empty array of package names/,
    },
    {
      name: "probe with duplicate up targets",
      raw: JSON.stringify([
        probedEntry({ probe: { up: ["@backstage/cli", "@backstage/cli"] } }),
      ]),
      message: /probe.up contains duplicates/,
    },
    {
      name: "tracking is not an https URL",
      raw: JSON.stringify([probedEntry({ tracking: "berry#7281" })]),
      message: /tracking must be an https URL/,
    },
    {
      name: "tracking is not a string",
      raw: JSON.stringify([probedEntry({ tracking: 7281 })]),
      message: /tracking must be an https URL/,
    },
  ];

  for (const invalidCase of invalidCases) {
    await t.test(invalidCase.name, () => {
      assert.throws(
        () => parseNonSecurityResolutions(invalidCase.raw),
        (error) =>
          error instanceof AuditPolicyError &&
          invalidCase.message.test(error.message),
      );
    });
  }
});

test("rejects malformed non-security declarations", async (t) => {
  const invalidCases = [
    { name: "non-array", raw: "{}", message: /must be a JSON array/ },
    { name: "invalid JSON", raw: "{", message: /must be valid JSON/ },
    {
      name: "unknown field",
      raw: JSON.stringify([{ ...nonSecurityEntry(), advisories: [GHSA] }]),
      message: /must contain pattern and reason, optionally probe and tracking/,
    },
    {
      name: "missing reason",
      raw: JSON.stringify([{ pattern: "@types/react", tracking: TRACKING_URL }]),
      message: /must contain pattern and reason, optionally probe and tracking/,
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
      name: "empty reason",
      raw: JSON.stringify([nonSecurityEntry({ reason: "" })]),
      message: /reason must be a non-empty string/,
    },
  ];

  for (const invalidCase of invalidCases) {
    await t.test(invalidCase.name, () => {
      assert.throws(
        () => parseNonSecurityResolutions(invalidCase.raw),
        invalidCase.message,
      );
    });
  }
});

test("sync passes when every package.json resolution is declared", () => {
  const result = checkSync(
    [registryEntry()],
    {
      "undici@npm:7.28.0": "^7.29.0",
      "@types/react": "^18",
    },
    [nonSecurityEntry()],
  );
  assert.deepEqual(result, { pass: true, problems: [] });
});

test("sync fails on a missing or mismatching package.json resolution", () => {
  const missing = checkSync([registryEntry()], { "@types/react": "^18" }, [
    nonSecurityEntry(),
  ]);
  assert.equal(missing.pass, false);
  assert.match(missing.problems[0], /missing from package.json resolutions/);

  const mismatch = checkSync([registryEntry()], {
    "undici@npm:7.28.0": "7.29.0",
  });
  assert.equal(mismatch.pass, false);
  assert.match(mismatch.problems[0], /resolves to 7.29.0 in package.json/);
});

test("sync fails on a package.json resolution declared in neither list", () => {
  const result = checkSync([], { "@types/react": "^18" });

  assert.equal(result.pass, false);
  assert.equal(result.problems.length, 1);
  assert.match(
    result.problems[0],
    /@types\/react is present in package.json resolutions but declared in neither/,
  );
});

test("sync fails when a non-security declaration has no package.json resolution", () => {
  const result = checkSync([], {}, [nonSecurityEntry()]);

  assert.equal(result.pass, false);
  assert.match(
    result.problems[0],
    /declared in yarn-resolutions-non-security.json but missing from package.json resolutions/,
  );
});

test("sync fails when a pattern is declared in both registry and non-security list", () => {
  const result = checkSync(
    [registryEntry()],
    { "undici@npm:7.28.0": "^7.29.0" },
    [nonSecurityEntry({ pattern: "undici@npm:7.28.0" })],
  );

  assert.equal(result.pass, false);
  assert.match(
    result.problems[0],
    /declared in both yarn-resolutions.json and yarn-resolutions-non-security.json/,
  );
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

const LOCKFILE_SAMPLE = [
  '"@backstage/cli@npm:^0.36.5":',
  "  version: 0.36.5",
  "",
  '"minimist@npm:^1.2.0, minimist@npm:^1.2.6":',
  "  version: 1.2.8",
  "",
  '"app@workspace:packages/app":',
  "  version: 0.0.0-use.local",
  "",
].join("\n");

test("accepts probe targets that are npm dependencies in the lockfile", () => {
  assert.doesNotThrow(() =>
    assertProbeTargetsInLockfile(probedEntry(), LOCKFILE_SAMPLE),
  );
  assert.doesNotThrow(() =>
    assertProbeTargetsInLockfile(
      probedEntry({ probe: { up: ["minimist"] } }),
      LOCKFILE_SAMPLE,
    ),
  );
});

test("rejects probe targets that yarn up -R would match vacuously", () => {
  for (const target of ["no-such-package", "cli", "app", "@backstage/cli-common"]) {
    assert.throws(
      () =>
        assertProbeTargetsInLockfile(
          probedEntry({ probe: { up: [target] } }),
          LOCKFILE_SAMPLE,
        ),
      (error) =>
        error instanceof AuditPolicyError &&
        new RegExp(`names ${target.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}, which is not an npm dependency`).test(
          error.message,
        ),
      `target ${target} should be rejected`,
    );
  }
});

test("summarizes a yarn failure by its report lines instead of the stack trace tail", () => {
  const stdout = [
    "➤ YN0000: ┌ Resolution step",
    "➤ YN0001: │ Error: got@patch:got@npm%3A11.8.2#~/.yarn/patches/got.patch: ENOENT: no such file or directory",
    "    at Object.openSync (node:fs:573:18)",
    "    at bundled (/tmp/x/.yarn/releases/yarn-4.13.0.cjs:1:12345)",
    "➤ YN0000: └ Completed",
    "➤ YN0000: · Failed with errors in 0s 42ms",
  ].join("\n");

  const summary = summarizeYarnFailure(stdout, "");
  assert.match(summary, /YN0001: │ Error: got@patch/);
  assert.match(summary, /Failed with errors/);
  assert.doesNotMatch(summary, /at Object.openSync/);
  assert.doesNotMatch(summary, /yarn-4.13.0.cjs/);

  // 報告行が無いときだけ末尾を返す
  assert.equal(summarizeYarnFailure("plain tail\n", ""), "plain tail");
});

test("classifies a probe as removable only when the control run passed", () => {
  const entry = probedEntry();

  assert.equal(classifyProbe(entry, 0, 0), "removable");
  assert.equal(classifyProbe(entry, 0, 1), "needed");
});

test("treats a failing control run as a mechanism failure, not as removable", () => {
  const entry = probedEntry();

  assert.throws(
    () => classifyProbe(entry, 1, 0),
    (error) =>
      error instanceof AuditPolicyError &&
      /probe control run for @yarnpkg\/core\/got failed/.test(error.message) &&
      /yarn up -R @backstage\/cli/.test(error.message),
  );
  assert.throws(
    () => classifyProbe(entry, null, null),
    (error) => error instanceof AuditPolicyError,
  );
});

test("applyRemoval drops the resolution and its declaration without touching others", () => {
  const manifest = {
    name: "root",
    resolutions: {
      "@types/react": "^18",
      "@yarnpkg/core/got": "npm:11.8.2",
      "undici@npm:7.28.0": "^7.29.0",
    },
  };
  const result = applyRemoval(
    manifest,
    [nonSecurityEntry(), probedEntry()],
    ["@yarnpkg/core/got"],
  );

  assert.deepEqual(result.manifest, {
    name: "root",
    resolutions: { "@types/react": "^18", "undici@npm:7.28.0": "^7.29.0" },
  });
  assert.deepEqual(result.nonSecurity, [nonSecurityEntry()]);
  // 入力は変更しない
  assert.equal(manifest.resolutions["@yarnpkg/core/got"], "npm:11.8.2");
});

test("applyRemoval removes the resolutions key when nothing is left", () => {
  const result = applyRemoval(
    { name: "root", resolutions: { "@yarnpkg/core/got": "npm:11.8.2" } },
    [probedEntry()],
    ["@yarnpkg/core/got"],
  );

  assert.deepEqual(result.manifest, { name: "root" });
  assert.deepEqual(result.nonSecurity, []);
});

test("applyRemoval fails closed on a pattern missing from package.json", () => {
  assert.throws(
    () => applyRemoval({ resolutions: {} }, [probedEntry()], ["@yarnpkg/core/got"]),
    (error) =>
      error instanceof AuditPolicyError &&
      /not present in package.json resolutions/.test(error.message),
  );
});

test("probe summary lists removable, needed, and not probed entries", () => {
  const summary = renderProbeSummary(
    [
      { entry: probedEntry(), resolution: "npm:11.8.2", outcome: "needed" },
      {
        entry: probedEntry({ pattern: "prettier@npm:^3.9.6", tracking: undefined }),
        resolution: "^3.9.6",
        outcome: "removable",
      },
    ],
    [nonSecurityEntry()],
  );

  assert.match(summary, /- Removable: 1/);
  assert.match(summary, /- Still needed: 1/);
  assert.match(summary, /- Not probed \(no probe declared\): 1/);
  assert.match(summary, /@yarnpkg\/core\/got \| @backstage\/cli \| https:\/\/github.com\/yarnpkg\/berry\/issues\/7281 \| still needed/);
  assert.match(summary, /prettier@npm:\^3.9.6 \| @backstage\/cli \| - \| removable: removal pull request will be created/);
  assert.match(summary, /@types\/react \| - \| - \| not probed/);
});

test("removal pull request body satisfies the PR policy and names each resolution", () => {
  const body = renderRemovalPullRequestBody(
    [{ entry: probedEntry(), resolution: "npm:11.8.2", outcome: "removable" }],
    { runUrl: "https://github.com/kmryst/idp-golden-path/actions/runs/1" },
  );

  assert.match(body, /^## 目的/m);
  assert.match(body, /probe を実行した run: https:\/\/github.com\/kmryst\/idp-golden-path\/actions\/runs\/1/);
  assert.match(body, /`@yarnpkg\/core\/got` \| `npm:11.8.2` \| `@backstage\/cli` \| https:\/\/github.com\/yarnpkg\/berry\/issues\/7281/);
  assert.match(body, /^## 変更内容/m);
  assert.match(body, /^## 可観測性\/検証/m);
  assert.match(body, /ADR-0015/);
  // PR Policy Check の Issue リンク規約: (close[sd]?|fix(e[sd])?|refs?) #[0-9]+
  assert.match(body, /^Refs #291$/m);
});

test("removal pull request body omits the run line without run metadata", () => {
  const body = renderRemovalPullRequestBody([
    { entry: probedEntry(), resolution: "npm:11.8.2", outcome: "removable" },
  ]);

  assert.doesNotMatch(body, /probe を実行した run/);
  assert.match(body, /^Refs #291$/m);
});
