import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  UnblockCheckError,
  checkLabeledIssuesCovered,
  checkLedgerSync,
  checkReviewDeadlines,
  checkTrackingIssues,
  commentMarker,
  decideVerdict,
  extractIgnoreEntries,
  parseLedger,
  probeEnvironment,
  postUnblockComments,
  renderSummary,
  runFull,
  runProbes,
  runSync,
} from "./dependabot-unblock-check.mjs";

const FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "dependabot",
);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPOSITORY = "kmryst/idp-golden-path";
const TODAY = "2026-08-09";
const OPTIONS = { today: TODAY, repository: REPOSITORY };

function fixture(name) {
  return readFileSync(join(FIXTURE_DIR, `${name}.yml`), "utf8");
}

function ledgerEntry(overrides = {}) {
  return {
    directory: "/backstage",
    "dependency-name": "jsdom",
    probe: true,
    spec: "jsdom@30",
    steps: ["yarn up jsdom@30", "yarn tsc", "CI=1 yarn test"],
    "review-by": "2026-11-02",
    tracking: "https://github.com/kmryst/idp-golden-path/issues/146",
    ...overrides,
  };
}

function parsed(overrides = {}) {
  return parseLedger(JSON.stringify([ledgerEntry(overrides)]), REPOSITORY);
}

function openIssue(number, labels = ["dependabot-ignore"]) {
  return { number, state: "open", labels };
}

function fakeGitHub(options = {}) {
  const {
    issues = new Map([[146, openIssue(146)]]),
    labeled = [146],
    comments = new Map(),
  } = options;
  const calls = [];

  return {
    calls,
    async getIssue(number) {
      calls.push(["getIssue", number]);
      const issue = issues.get(number);
      if (issue === undefined) {
        throw new UnblockCheckError(`issue ${number} not found`);
      }
      return issue;
    },
    async listLabeledOpenIssues() {
      calls.push(["listLabeledOpenIssues"]);
      return [...labeled];
    },
    async listIssueCommentBodies(number) {
      calls.push(["listIssueCommentBodies", number]);
      return [...(comments.get(number) ?? [])];
    },
    async createIssueComment(number, body) {
      calls.push(["createIssueComment", number, body]);
      comments.set(number, [...(comments.get(number) ?? []), body]);
    },
  };
}

// ---------------------------------------------------------------------------
// dependabot.yml 抽出（3 フィクスチャのスナップショット）
// ---------------------------------------------------------------------------

test("extracts the idp-golden-path ignore entries", () => {
  assert.deepEqual(
    extractIgnoreEntries(fixture("idp-golden-path")).map(
      ({ directory, dependencyName, reviewBy, trackingIssue, updateTypes }) => ({
        directory,
        dependencyName,
        reviewBy,
        trackingIssue,
        updateTypes,
      }),
    ),
    [
      {
        directory: "/backstage",
        dependencyName: "jsdom",
        reviewBy: "2026-11-02",
        trackingIssue: 146,
        updateTypes: '["version-update:semver-major"]',
      },
    ],
  );
});

test("extracts the terraform-hannibal ignore entries", () => {
  assert.deepEqual(
    extractIgnoreEntries(fixture("terraform-hannibal")).map(
      ({ directory, dependencyName, reviewBy, trackingIssue }) => ({
        directory,
        dependencyName,
        reviewBy,
        trackingIssue,
      }),
    ),
    [
      {
        directory: "/",
        dependencyName: "typescript",
        reviewBy: "2026-11-02",
        trackingIssue: 542,
      },
      {
        directory: "/",
        dependencyName: "eslint",
        reviewBy: "2026-11-02",
        trackingIssue: 551,
      },
      {
        directory: "/",
        dependencyName: "@types/node",
        reviewBy: "2026-11-02",
        trackingIssue: 555,
      },
      {
        directory: "/",
        dependencyName: "graphql",
        reviewBy: "2026-11-02",
        trackingIssue: 564,
      },
      {
        directory: "/client",
        dependencyName: "typescript",
        reviewBy: "2026-11-02",
        trackingIssue: 542,
      },
    ],
  );
});

test("extracts the ticket-c2c-platform ignore entries", () => {
  assert.deepEqual(
    extractIgnoreEntries(fixture("ticket-c2c-platform")).map(
      ({ directory, dependencyName, reviewBy, trackingIssue }) => ({
        directory,
        dependencyName,
        reviewBy,
        trackingIssue,
      }),
    ),
    [
      {
        directory: "/",
        dependencyName: "typescript",
        reviewBy: "2026-11-02",
        trackingIssue: 425,
      },
      {
        directory: "/frontend",
        dependencyName: "typescript",
        reviewBy: "2026-11-02",
        trackingIssue: 426,
      },
      {
        directory: "/frontend",
        dependencyName: "eslint",
        reviewBy: "2026-11-02",
        trackingIssue: 427,
      },
    ],
  );
});

test("the leading cross-repository search comment is not attributed to an entry", () => {
  // 3 リポジトリとも先頭に横断検索リンクのコメント 1 行がある。
  // これがエントリのコメントブロックに混ざると 見直し期限 / 追跡 の件数検査が狂う
  const entries = extractIgnoreEntries(fixture("ticket-c2c-platform"));
  assert.equal(entries.length, 3);
  assert.equal(entries[0].trackingIssue, 425);
});

// ---------------------------------------------------------------------------
// 抽出の負のテスト（fail closed）
// ---------------------------------------------------------------------------

const IGNORE_HEADER = [
  "version: 2",
  "updates:",
  '  - package-ecosystem: "npm"',
  '    directory: "/"',
  "    ignore:",
].join("\n");

function withIgnoreBody(body) {
  return `${IGNORE_HEADER}\n${body}\n`;
}

const VALID_BODY = [
  "      # 見直し期限: 2026-11-02（棚卸し）",
  "      # 追跡: Issue #542",
  '      - dependency-name: "typescript"',
  '        update-types: ["version-update:semver-major"]',
].join("\n");

test("a valid synthetic ignore block parses", () => {
  assert.equal(extractIgnoreEntries(withIgnoreBody(VALID_BODY)).length, 1);
});

test("throws when the review deadline comment is missing", () => {
  const body = [
    "      # 追跡: Issue #542",
    '      - dependency-name: "typescript"',
  ].join("\n");
  assert.throws(() => extractIgnoreEntries(withIgnoreBody(body)), UnblockCheckError);
});

test("throws when the tracking comment is duplicated", () => {
  const body = [
    "      # 見直し期限: 2026-11-02（棚卸し）",
    "      # 追跡: Issue #542",
    "      # 追跡: Issue #543",
    '      - dependency-name: "typescript"',
  ].join("\n");
  assert.throws(() => extractIgnoreEntries(withIgnoreBody(body)), UnblockCheckError);
});

test("throws on versions-style ignore entries", () => {
  const body = [
    "      # 見直し期限: 2026-11-02（棚卸し）",
    "      # 追跡: Issue #542",
    '      - dependency-name: "typescript"',
    '        versions: [">=6.1.0"]',
  ].join("\n");
  assert.throws(() => extractIgnoreEntries(withIgnoreBody(body)), UnblockCheckError);
});

test("throws on a dependency-name outside an ignore block", () => {
  const source = [
    "version: 2",
    "updates:",
    '  - package-ecosystem: "npm"',
    '    directory: "/"',
    "    allow:",
    '      - dependency-name: "typescript"',
  ].join("\n");
  assert.throws(() => extractIgnoreEntries(source), UnblockCheckError);
});

test("throws on broken indentation inside an ignore block", () => {
  const body = [
    "      # 見直し期限: 2026-11-02（棚卸し）",
    "      # 追跡: Issue #542",
    '       - dependency-name: "typescript"',
  ].join("\n");
  assert.throws(() => extractIgnoreEntries(withIgnoreBody(body)), UnblockCheckError);
});

test("throws on a duplicated ignore entry", () => {
  assert.throws(
    () => extractIgnoreEntries(withIgnoreBody(`${VALID_BODY}\n${VALID_BODY}`)),
    UnblockCheckError,
  );
});

test("throws on a flow-style ignore instead of silently skipping it", () => {
  // 見逃すと「台帳にも追跡 Issue にも載らない ignore」が成立してしまう
  const source = [
    "version: 2",
    "updates:",
    '  - package-ecosystem: "npm"',
    '    directory: "/"',
    '    ignore: [{dependency-name: "evil", update-types: ["version-update:semver-major"]}]',
  ].join("\n");
  assert.throws(() => extractIgnoreEntries(source), UnblockCheckError);
});

test("throws on a quoted ignore key", () => {
  const source = [
    "version: 2",
    "updates:",
    '  - package-ecosystem: "npm"',
    '    directory: "/"',
    '    "ignore":',
  ].join("\n");
  assert.throws(() => extractIgnoreEntries(source), UnblockCheckError);
});

test("comment metadata is not carried over to the next ignore entry", () => {
  const body = [
    "      # 見直し期限: 2026-11-02（棚卸し）",
    "      # 追跡: Issue #542",
    '      - dependency-name: "typescript"',
    "        # 見直し期限: 2099-01-01",
    "        # 追跡: Issue #999",
    '        update-types: ["version-update:semver-major"]',
    '      - dependency-name: "eslint"',
  ].join("\n");
  assert.throws(() => extractIgnoreEntries(withIgnoreBody(body)), UnblockCheckError);
});

test("throws on tab characters", () => {
  assert.throws(
    () => extractIgnoreEntries("version: 2\n\tupdates:\n"),
    UnblockCheckError,
  );
});

// ---------------------------------------------------------------------------
// 台帳スキーマ
// ---------------------------------------------------------------------------

test("parses a probe ledger entry", () => {
  const [entry] = parsed();
  assert.equal(entry.dependencyName, "jsdom");
  assert.equal(entry.trackingIssue, 146);
  assert.equal(entry.probe, true);
});

test("parses a probe: false entry with a skip reason", () => {
  const [entry] = parseLedger(
    JSON.stringify([
      {
        directory: "/",
        "dependency-name": "eslint",
        probe: false,
        "probe-skip-reason": "flat config 未移行のため自リポジトリ作業待ち",
        "review-by": "2026-11-02",
        tracking: "https://github.com/kmryst/idp-golden-path/issues/151",
      },
    ]),
    REPOSITORY,
  );
  assert.equal(entry.probe, false);
  assert.equal(entry.steps, null);
});

test("rejects probe: false without a skip reason", () => {
  assert.throws(
    () =>
      parseLedger(
        JSON.stringify([
          {
            directory: "/",
            "dependency-name": "eslint",
            probe: false,
            "review-by": "2026-11-02",
            tracking: "https://github.com/kmryst/idp-golden-path/issues/151",
          },
        ]),
        REPOSITORY,
      ),
    UnblockCheckError,
  );
});

test("rejects probe: true with empty steps", () => {
  assert.throws(() => parsed({ steps: [] }), UnblockCheckError);
});

test("rejects a spec that is not a pinned major", () => {
  assert.throws(() => parsed({ spec: "jsdom@latest" }), UnblockCheckError);
});

test("rejects a spec targeting another dependency", () => {
  assert.throws(() => parsed({ spec: "eslint@10" }), UnblockCheckError);
});

test("rejects a tracking URL from another repository", () => {
  assert.throws(
    () =>
      parsed({ tracking: "https://github.com/kmryst/terraform-hannibal/issues/542" }),
    UnblockCheckError,
  );
});

test("rejects an invalid review-by date", () => {
  assert.throws(() => parsed({ "review-by": "2026-02-30" }), UnblockCheckError);
});

test("allows duplicated tracking URLs across entries", () => {
  const entries = parseLedger(
    JSON.stringify([
      ledgerEntry({ directory: "/" }),
      ledgerEntry({ directory: "/client" }),
    ]),
    REPOSITORY,
  );
  assert.equal(entries.length, 2);
  assert.equal(entries[0].trackingIssue, entries[1].trackingIssue);
});

test("rejects duplicated directory + dependency-name", () => {
  assert.throws(
    () =>
      parseLedger(
        JSON.stringify([ledgerEntry(), ledgerEntry()]),
        REPOSITORY,
      ),
    UnblockCheckError,
  );
});

// ---------------------------------------------------------------------------
// 検査 1〜5
// ---------------------------------------------------------------------------

test("check 2 passes when the ledger matches dependabot.yml", () => {
  assert.deepEqual(
    checkLedgerSync(parsed(), extractIgnoreEntries(fixture("idp-golden-path"))),
    [],
  );
});

test("check 2 fails on a review-by value mismatch", () => {
  const problems = checkLedgerSync(
    parsed({ "review-by": "2026-12-01" }),
    extractIgnoreEntries(fixture("idp-golden-path")),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /review-by が不一致/);
});

test("check 2 fails on a tracking issue mismatch", () => {
  const problems = checkLedgerSync(
    parsed({ tracking: "https://github.com/kmryst/idp-golden-path/issues/134" }),
    extractIgnoreEntries(fixture("idp-golden-path")),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /追跡 Issue が不一致/);
});

test("check 2 fails when an ignore is missing from the ledger", () => {
  const problems = checkLedgerSync(
    [],
    extractIgnoreEntries(fixture("idp-golden-path")),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /台帳に未収載/);
});

test("check 2 fails when the ledger has an entry with no ignore", () => {
  const problems = checkLedgerSync(parsed(), []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /dependabot.yml にない/);
});

test("check 5 passes before the review deadline", () => {
  assert.deepEqual(
    checkReviewDeadlines(extractIgnoreEntries(fixture("idp-golden-path")), TODAY),
    [],
  );
});

test("check 5 fails after the review deadline", () => {
  const problems = checkReviewDeadlines(
    extractIgnoreEntries(fixture("idp-golden-path")),
    "2026-11-03",
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /見直し期限 2026-11-02 を過ぎている/);
});

test("check 1 fails when the tracking issue is closed", () => {
  const problems = checkTrackingIssues(
    parsed(),
    new Map([[146, { number: 146, state: "closed", labels: ["dependabot-ignore"] }]]),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /closed になっている/);
});

test("check 3 fails when the tracking issue has no dependabot-ignore label", () => {
  const problems = checkTrackingIssues(
    parsed(),
    new Map([[146, openIssue(146, ["type:chore"])]]),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /dependabot-ignore ラベルが付いていない/);
});

test("checks 1 and 3 query a duplicated tracking issue only once", () => {
  const problems = checkTrackingIssues(
    parseLedger(
      JSON.stringify([
        ledgerEntry({ directory: "/" }),
        ledgerEntry({ directory: "/client" }),
      ]),
      REPOSITORY,
    ),
    new Map([[146, openIssue(146, [])]]),
  );
  assert.equal(problems.length, 1);
});

test("check 4 fails when a labeled open issue is missing from the ledger", () => {
  const problems = checkLabeledIssuesCovered(parsed(), [146, 999]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /#999 が台帳にない/);
});

test("check 4 passes when every labeled open issue is tracked", () => {
  assert.deepEqual(checkLabeledIssuesCovered(parsed(), [146]), []);
});

// ---------------------------------------------------------------------------
// verdict の優先順位
// ---------------------------------------------------------------------------

test("verdict is OK when nothing needs a human", () => {
  const verdict = decideVerdict([], [], 1);
  assert.equal(verdict.exitCode, 0);
  assert.equal(verdict.headline, "OK: still blocked（probe 1 件、全て想定どおり失敗）");
});

test("verdict is UNBLOCKED with exit 10 when a probe succeeded", () => {
  const verdict = decideVerdict(
    [],
    [{ dependencyName: "jsdom", resolvedVersion: "31.0.0", trackingIssue: 146 }],
    1,
  );
  assert.equal(verdict.exitCode, 10);
  assert.match(verdict.headline, /^UNBLOCKED: jsdom@31\.0\.0 が通りました/);
  assert.match(verdict.headline, /#146/);
});

test("MECHANISM outranks UNBLOCKED", () => {
  const verdict = decideVerdict(
    ["追跡 Issue #146 が closed になっている"],
    [{ dependencyName: "jsdom", resolvedVersion: "31.0.0", trackingIssue: 146 }],
    1,
  );
  assert.equal(verdict.exitCode, 1);
  assert.match(verdict.headline, /^MECHANISM: /);
});

test("the sync verdict does not claim a probe count", () => {
  const verdict = decideVerdict([], [], null);
  assert.equal(verdict.exitCode, 0);
  assert.match(verdict.headline, /^OK: still blocked（sync: /);
});

test("the summary starts with the verdict headline", () => {
  const verdict = decideVerdict([], [], 0);
  assert.equal(
    renderSummary(verdict, { mode: "sync" }).split("\n")[0],
    `## ${verdict.headline}`,
  );
});

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

function probeDeps(options = {}) {
  const { failingStep = null, latest = "30.0.1", resolved = "30.0.1" } = options;
  const commands = [];
  const removed = [];

  return {
    commands,
    removed,
    runCommand(command, cwd) {
      commands.push([command, cwd]);
      if (failingStep !== null && command === failingStep) {
        return { status: 1, stdout: "", stderr: "boom" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    resolveVersion(spec) {
      return spec.includes("@") ? resolved : latest;
    },
    removeDirectory(directory) {
      removed.push(directory);
    },
  };
}

test("a failing probe step means the dependency is still blocked", () => {
  const deps = probeDeps({ failingStep: "CI=1 yarn test" });
  const { probes } = runProbes(parsed(), deps);
  assert.equal(probes.length, 1);
  assert.equal(probes[0].succeeded, false);
  assert.equal(probes[0].status, "still blocked");
  // 失敗ステップ以降は実行しない
  assert.equal(
    deps.commands.filter(([command]) => command === "yarn tsc").length,
    1,
  );
});

test("the probe directory is reset before and after each entry", () => {
  const deps = probeDeps({ failingStep: "yarn up jsdom@30" });
  runProbes(parsed(), deps);
  assert.deepEqual(deps.removed, ["/backstage", "/backstage"]);
  assert.equal(
    deps.commands.filter(([command]) =>
      command.startsWith("git checkout -- . && git clean -fd"),
    ).length,
    2,
  );
});

test("probe: false entries are skipped without running commands", () => {
  const deps = probeDeps();
  const ledger = parseLedger(
    JSON.stringify([
      {
        directory: "/",
        "dependency-name": "eslint",
        probe: false,
        "probe-skip-reason": "flat config 未移行",
        "review-by": "2026-11-02",
        tracking: "https://github.com/kmryst/idp-golden-path/issues/151",
      },
    ]),
    REPOSITORY,
  );
  const { probes } = runProbes(ledger, deps);
  assert.equal(probes[0].status, "skipped");
  assert.deepEqual(deps.commands, []);
});

test("warns when the latest major moved past the ledger spec", () => {
  const deps = probeDeps({ failingStep: "yarn tsc", latest: "31.2.0" });
  const { warnings } = runProbes(parsed(), deps);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /台帳の spec jsdom@30 より先に進んでいる/);
});

test("the probe environment carries no workflow or registry token", () => {
  const env = probeEnvironment({
    PATH: "/usr/bin",
    GITHUB_TOKEN: "secret",
    GH_TOKEN: "secret",
    NODE_AUTH_TOKEN: "secret",
    NPM_TOKEN: "secret",
  });
  assert.equal(env.CI, "1");
  assert.equal(env.PATH, "/usr/bin");
  for (const key of ["GITHUB_TOKEN", "GH_TOKEN", "NODE_AUTH_TOKEN", "NPM_TOKEN"]) {
    assert.equal(Object.hasOwn(env, key), false);
  }
});

test("the reset command keeps the reusable workflow sparse checkout", () => {
  const deps = probeDeps({ failingStep: "yarn tsc" });
  runProbes(parsed(), deps);
  for (const [command] of deps.commands.filter(([c]) => c.startsWith("git checkout"))) {
    assert.match(command, /-e \.idp-golden-path-workflow/);
  }
});

// ---------------------------------------------------------------------------
// Issue コメント
// ---------------------------------------------------------------------------

test("posts a marker comment on the tracking issue", async () => {
  const github = fakeGitHub();
  const posted = await postUnblockComments(
    [
      {
        directory: "/backstage",
        dependencyName: "jsdom",
        resolvedVersion: "31.0.0",
        trackingIssue: 146,
        steps: ["yarn up jsdom@31"],
      },
    ],
    github,
  );
  assert.deepEqual(posted, [{ issue: 146, created: true }]);
  const [, , body] = github.calls.find(([name]) => name === "createIssueComment");
  assert.ok(body.startsWith(commentMarker("jsdom", "31.0.0")));
});

test("does not repost when the same resolved version is already recorded", async () => {
  const github = fakeGitHub({
    comments: new Map([[146, [`${commentMarker("jsdom", "31.0.0")}\n過去の記録`]]]),
  });
  const posted = await postUnblockComments(
    [
      {
        directory: "/backstage",
        dependencyName: "jsdom",
        resolvedVersion: "31.0.0",
        trackingIssue: 146,
        steps: ["yarn up jsdom@31"],
      },
    ],
    github,
  );
  assert.deepEqual(posted, [{ issue: 146, created: false }]);
  assert.equal(
    github.calls.filter(([name]) => name === "createIssueComment").length,
    0,
  );
});

// ---------------------------------------------------------------------------
// runSync / runFull
// ---------------------------------------------------------------------------

test("runSync passes against the repository's own ledger and dependabot.yml", () => {
  const { verdict } = runSync(REPO_ROOT, OPTIONS);
  assert.equal(verdict.exitCode, 0);
  assert.match(verdict.headline, /^OK: still blocked/);
});

test("runSync never reaches command execution or the network", () => {
  // sync のセキュリティ契約: 台帳の steps を spawn しない。
  // runSync は deps を受け取らないため、注入経路そのものが存在しないことを型で示す
  assert.equal(runSync.length, 1);
  const { summary } = runSync(REPO_ROOT, OPTIONS);
  assert.match(summary, /mode: `sync`/);
});

function fullDeps(options = {}) {
  return { ...probeDeps(options), github: options.github ?? fakeGitHub() };
}

test("runFull is green when every probe fails as expected", async () => {
  const { verdict, summary } = await runFull(
    REPO_ROOT,
    fullDeps({ failingStep: "CI=1 yarn test" }),
    OPTIONS,
  );
  assert.equal(verdict.exitCode, 0);
  assert.match(summary.split("\n")[0], /^## OK: still blocked/);
});

test("runFull exits 10 and comments before exiting when a probe succeeds", async () => {
  const github = fakeGitHub();
  const { verdict } = await runFull(REPO_ROOT, fullDeps({ github }), OPTIONS);
  assert.equal(verdict.exitCode, 10);

  const commentIndex = github.calls.findIndex(
    ([name]) => name === "createIssueComment",
  );
  assert.notEqual(commentIndex, -1);
  // exit する前に記録が残ることを、runFull の解決前にコメントが存在することで確認する
  assert.equal(github.calls[commentIndex][1], 146);
});

test("runFull exits 1 when the tracking issue is closed", async () => {
  const github = fakeGitHub({
    issues: new Map([
      [146, { number: 146, state: "closed", labels: ["dependabot-ignore"] }],
    ]),
    labeled: [],
  });
  const { verdict } = await runFull(REPO_ROOT, fullDeps({ github }), OPTIONS);
  assert.equal(verdict.exitCode, 1);
  assert.match(verdict.headline, /^MECHANISM: .*closed になっている/);
});

test("runFull exits 1 when the tracking issue has no label", async () => {
  const github = fakeGitHub({
    issues: new Map([[146, openIssue(146, [])]]),
    labeled: [],
  });
  const { verdict } = await runFull(REPO_ROOT, fullDeps({ github }), OPTIONS);
  assert.equal(verdict.exitCode, 1);
  assert.match(verdict.headline, /dependabot-ignore ラベルが付いていない/);
});

test("runFull exits 1 when a labeled open issue is missing from the ledger", async () => {
  const github = fakeGitHub({ labeled: [146, 999] });
  const { verdict } = await runFull(REPO_ROOT, fullDeps({ github }), OPTIONS);
  assert.equal(verdict.exitCode, 1);
  assert.match(verdict.headline, /#999 が台帳にない/);
});

test("runFull does not run probes while the mechanism is broken", async () => {
  const github = fakeGitHub({ labeled: [146, 999] });
  const deps = fullDeps({ github });
  await runFull(REPO_ROOT, deps, OPTIONS);
  assert.deepEqual(deps.commands, []);
  assert.equal(
    github.calls.filter(([name]) => name === "createIssueComment").length,
    0,
  );
});
