import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { assess, assessRow, markerNote, MIN_AGE_MS } from "../src/core/assess";
import { orphanRow } from "../src/core/scan/orphans";
import { parseWorktrunk } from "../src/core/worktrunk/list";
import fixture from "./fixtures/list-v2.json";
import type {
  ChangeFlags,
  ForgeCheck,
  OrphanCause,
  WorktreeFacts,
  WorktreeRow,
} from "../src/core/types";

const base = {
  ...parseWorktrunk("/repo", JSON.stringify(fixture))[0]!,
  mainBase: "origin/main",
  createdAt: "2026-09-27T00:00:00Z",
};
const assessment = (update: Partial<WorktreeFacts> = {}) => assess({ ...base, ...update });

test.each([
  [{ operation: "rebase" }, "rebase in progress", "Busy", true],
  [{ operation: "cherry_pick" }, "cherry-pick in progress", "Busy", true],
  [{ changes: { ...base.changes!, conflicted: true } }, "unresolved conflicts", "Busy", true],
  [{ prunable: true }, "folder missing", "Broken", true],
  [{ locked: true, lockReason: "manual" }, "locked", "Review", true],
  [{ changes: null }, "status unknown", "Review", true],
  [{ changes: { ...base.changes!, conflicted: null } }, "status unknown", "Review", true],
  [{ changes: { ...base.changes!, untracked: true } }, "uncommitted changes", "Review", false],
  [{ upstreamAhead: 1 }, "unpushed commits", "Review", false],
  [{ upstreamAhead: 140 }, "unpushed commits", "Review", false],
  [{ mainState: "ahead", mainAhead: 3 }, "unmerged commits", "Review", false],
  [{ mainState: "would_conflict" }, "unmerged commits", "Review", false],
  [{ mainState: "diverged" }, "unmerged commits", "Review", false],
  [{ mainState: "behind" }, "behind main", "Review", false],
  [{ mainState: "orphan" }, "unrelated history", "Review", false],
  [{ mainState: "integrated" }, "merged", "Safe", false],
  [{ mainState: "empty" }, "no new commits", "Safe", false],
  [{ mainState: "same_commit" }, "no new commits", "Safe", false],
  [{ mainState: "integrated", integrationReason: "same_commit" }, "no new commits", "Safe", false],
  [{ mainState: "integrated", integrationReason: "ancestor" }, "merged", "Safe", false],
  [{ mainState: null }, "status unknown", "Review", true],
  [{ mainState: "unexpected" }, "status unknown", "Review", true],
  [{ path: "relative" }, "status unknown", "Review", true],
] as const)("Git-only status for %j", (update, status, verdict, blocked) => {
  const result = assessment(update);
  expect(result.status).toBe(status);
  expect(result.verdict).toBe(verdict);
  expect(result.removalBlockReason !== null).toBe(blocked);
});

const now = Date.parse("2026-10-28T12:00:00Z");
const createdBefore = (ms: number) => new Date(now - ms).toISOString();
const noNewCommits: Partial<WorktreeFacts>[] = [
  { mainState: "empty", integrationReason: "same_commit" },
  { mainState: "same_commit" },
  { mainState: "integrated", integrationReason: "same_commit" },
  { mainState: "integrated", integrationReason: "ancestor" },
];

test.each(noNewCommits)(
  "a worktree with no new commits created under a day ago needs review: %j",
  (update) => {
    const result = assess({ ...base, ...update, createdAt: createdBefore(2 * 3_600_000) }, now);
    expect(result.verdict).toBe("Review");
    expect(result.reason).toBe("Created 2h ago, so it may still be in use.");
    expect(result.removalBlockReason).toBeNull();
  },
);

test.each(noNewCommits)("a worktree with no new commits is Safe once a day old: %j", (update) => {
  const result = assess({ ...base, ...update, createdAt: createdBefore(MIN_AGE_MS) }, now);
  expect(result.verdict).toBe("Safe");
  expect(result.reason).toContain("origin/main");
});

test.each(noNewCommits)(
  "a worktree with no new commits and an unknown creation time needs review: %j",
  (update) => {
    const result = assess({ ...base, ...update, createdAt: null }, now);
    expect(result.verdict).toBe("Review");
    expect(result.reason).toBe("Its creation time is unknown, so it may still be in use.");
    expect(result.removalBlockReason).toBeNull();
  },
);

test("the creation age reads in minutes, and a clock that runs behind reads as just now", () => {
  const young = (ms: number) =>
    assess({ ...base, mainState: "empty", createdAt: createdBefore(ms) }, now).reason;
  expect(young(5 * 60_000)).toBe("Created 5m ago, so it may still be in use.");
  expect(young(-60_000)).toBe("Created just now, so it may still be in use.");
});

test("a young worktree whose own commits were squash-merged stays Safe", () => {
  for (const createdAt of [createdBefore(60_000), null]) {
    const result = assess({ ...base, integrationReason: "patch_id_match", createdAt }, now);
    expect(result.verdict).toBe("Safe");
  }
});

test("a lock outranks cleanup warnings and preserves Git's complete reason", () => {
  const lockReason = "claude session my-app (pid 24621 start Wed Sep 23 15:55:03 2026)";
  const result = assessment({ locked: true, lockReason, mainState: "ahead", upstreamAhead: 3 });
  expect(result.status).toBe("locked");
  expect(result.reason).toContain(lockReason);
  expect(result.removalBlockReason).toContain(lockReason);
  expect(result.reason).not.toContain("ended");
});

test("Git blockers take precedence over reviewable local changes", () => {
  const changes = { ...base.changes!, modified: true };
  expect(assessment({ changes, mainState: null }).status).toBe("status unknown");
  expect(assessment({ changes, locked: true }).status).toBe("locked");
  expect(assessment({ changes: { ...changes, conflicted: true }, locked: true }).status).toBe(
    "unresolved conflicts",
  );
  expect(assessment({ operation: "rebase", prunable: true }).verdict).toBe("Busy");
});

test("one status describes local changes even when commits are unpushed and not merged", () => {
  const result = assessment({
    changes: { ...base.changes!, modified: true },
    upstreamAhead: 2,
    mainState: "ahead",
  });
  expect(result.status).toBe("uncommitted changes");
  expect(result.verdict).toBe("Review");
  expect(result.removalBlockReason).toBeNull();
});

test("details name the comparison base and integration evidence", () => {
  const result = assessment({ integrationReason: "patch_id_match" });
  expect(result.reason).toContain("origin/main");
  expect(result.reason).toContain("squash or rebase merge");
  expect(assessment({ mainState: "ahead", mainAhead: 3 }).reason).toContain("3 commits");
  expect(assessment({ mainState: "would_conflict" }).reason).toContain("would conflict");
  expect(assessment({ mainState: "ahead", mainAhead: 1 }).reason).toBe(
    "1 commit isn't in origin/main.",
  );
});

test.each([
  { operation: "rebase" },
  { prunable: true },
  { locked: true, lockReason: null },
  { changes: null },
] as const)(
  'block reasons complete "Can\'t remove x: …" without repeating details for %j',
  (update) => {
    const result = assessment(update);
    expect(result.removalBlockReason).toMatch(/^[a-z]/);
    expect(result.removalBlockReason).not.toBe(result.reason);
  },
);

const marked = (marker: string | null, setBefore: number | null): Partial<WorktreeFacts> => ({
  marker,
  markerSetAt: setBefore === null ? null : new Date(now - setBefore).toISOString(),
});

test.each([
  ["🤖", 20 * 60_000, "An agent was working here 20m ago."],
  ["💬", 3 * 3_600_000, "An agent was waiting for input here 3h ago."],
  ["🤖", null, "An agent was working here; when is unknown."],
] as const)("an agent mark %s set %p ms ago turns Safe into Review", (marker, age, reason) => {
  const result = assess({ ...base, ...marked(marker, age) }, now);
  expect(result.verdict).toBe("Review");
  expect(result.status).toBe("merged");
  expect(result.reason).toBe(reason);
  expect(result.removalBlockReason).toBeNull();
  expect(markerNote({ ...base, ...marked(marker, age) }, now)).toBe(reason);
});

test("an agent mark older than a day leaves the verdict alone and reads as stale", () => {
  const facts = { ...base, ...marked("🤖", 28 * MIN_AGE_MS) };
  expect(assess(facts, now).verdict).toBe("Safe");
  expect(markerNote(facts, now)).toBe("Agent mark from 28d ago, likely stale.");
});

test("any other marker only shows in the details", () => {
  const facts = { ...base, ...marked("✅", 60_000) };
  expect(assess(facts, now).verdict).toBe("Safe");
  expect(markerNote(facts, now)).toBe("Marked ✅ 1m ago.");
  expect(markerNote({ ...base, ...marked("✅", null) }, now)).toBe("Marked ✅.");
  expect(markerNote({ ...base, ...marked(null, null) }, now)).toBeNull();
});

test("Busy, Broken and blocked verdicts outrank a recent agent mark", () => {
  const mark = marked("🤖", 60_000);
  expect(assess({ ...base, ...mark, operation: "rebase" }, now).verdict).toBe("Busy");
  expect(assess({ ...base, ...mark, prunable: true }, now).verdict).toBe("Broken");
  const locked = assess({ ...base, ...mark, locked: true, lockReason: "manual" }, now);
  expect([locked.status, locked.removalBlockReason]).toEqual([
    "locked",
    "it's locked (manual); unlock it first",
  ]);
  const dirty = assess({ ...base, ...mark, changes: { ...base.changes!, modified: true } }, now);
  expect(dirty.reason).toBe("Removing it deletes work that isn't committed.");
});

const leftover: WorktreeFacts = {
  ...base,
  id: "/repo\0branch\0old",
  kind: "branch",
  path: null,
  branch: "old",
  changes: null,
  tool: "Other",
};
const branch = (update: Partial<WorktreeFacts>) => assess({ ...leftover, ...update }, now);

test.each(["ancestor", "same_commit", "patch_id_match", "trees_match", "merge_adds_nothing"])(
  "a merged branch without a worktree (%s) is Safe only once a day old",
  (integrationReason) => {
    const facts = { mainState: "integrated", integrationReason };
    expect(branch({ ...facts, createdAt: createdBefore(MIN_AGE_MS) }).verdict).toBe("Safe");
    const young = branch({ ...facts, createdAt: createdBefore(2 * 3_600_000) });
    expect([young.verdict, young.reason, young.removalBlockReason]).toEqual([
      "Review",
      "Created 2h ago, so it may still be in use.",
      null,
    ]);
    const unknown = branch({ ...facts, createdAt: null });
    expect([unknown.verdict, unknown.reason]).toEqual([
      "Review",
      "Its creation time is unknown, so it may still be in use.",
    ]);
  },
);

test.each([
  ["ahead", "unmerged commits"],
  ["would_conflict", "unmerged commits"],
  ["diverged", "unmerged commits"],
  ["orphan", "unrelated history"],
])("a branch without a worktree that is %s needs review", (mainState, status) => {
  const result = branch({ mainState, mainAhead: 2 });
  expect([result.verdict, result.status, result.removalBlockReason]).toEqual([
    "Review",
    status,
    null,
  ]);
});

test("a branch without a worktree needs no files, but an unknown state still blocks it", () => {
  expect(branch({ mainState: "integrated" }).status).toBe("merged");
  expect(branch({ mainState: null }).removalBlockReason).toBe(
    "its Git status is unknown; press r to rescan",
  );
});

test("a recent agent mark keeps a merged branch without a worktree out of Safe", () => {
  const result = branch({ mainState: "integrated", ...marked("💬", 5 * 60_000) });
  expect([result.verdict, result.reason]).toEqual([
    "Review",
    "An agent was waiting for input here 5m ago.",
  ]);
});

const cleanChanges: ChangeFlags = {
  staged: false,
  modified: false,
  untracked: false,
  renamed: false,
  deleted: false,
  conflicted: false,
};
const cleanFacts: WorktreeFacts = {
  id: "repo\0path",
  repoPath: "/repo",
  repoName: "repo",
  path: "/repo/worktree",
  branch: "feature",
  headSha: "abc",
  committedAt: "2026-09-28T00:00:00Z",
  createdAt: "2026-09-27T00:00:00Z",
  kind: "worktree",
  marker: null,
  markerSetAt: null,
  tool: "Other",
  changes: cleanChanges,
  upstreamAhead: 0,
  mainState: "integrated",
  lockReason: null,
  mainAhead: null,
  mainBehind: null,
  mainDiff: null,
  subject: null,
  description: null,
  vars: null,
  defaultBranch: "main",
  mainBase: "main",
  locked: false,
  prunable: false,
  operation: null,
};

describe("verdict precedence", () => {
  test("Busy outranks Broken", () => {
    expect(assess({ ...cleanFacts, prunable: true, operation: "rebase" }).verdict).toBe("Busy");
  });

  test.each([
    ["lock", { locked: true }],
    ["local edits", { changes: { ...cleanChanges, modified: true } }],
    ["untracked files", { changes: { ...cleanChanges, untracked: true } }],
    ["upstream commits", { upstreamAhead: 2 }],
    ["unknown main state", { mainState: null }],
  ] as const)("%s needs review", (_label, update) => {
    expect(assess({ ...cleanFacts, ...update }).verdict).toBe("Review");
  });

  test("clean integrated and empty worktrees are Safe", () => {
    expect(assess(cleanFacts).verdict).toBe("Safe");
    expect(assess({ ...cleanFacts, mainState: "empty" }).verdict).toBe("Safe");
  });
});

const gitdir = "/Users/me/old/app/.git/worktrees/app";
test.each([
  [
    { kind: "gitdirMissing", gitdir, repo: "/Users/me/old/app", repoExists: false },
    "repository gone",
    "Its repository at /Users/me/old/app no longer exists.",
  ],
  [
    { kind: "gitdirMissing", gitdir, repo: "/Users/me/old/app", repoExists: true },
    "unknown to its repo",
    "Its repository at /Users/me/old/app no longer lists it.",
  ],
  [
    { kind: "gitdirMissing", gitdir: "/Users/me/records/app", repo: null, repoExists: false },
    "Git record gone",
    "Its Git record at /Users/me/records/app no longer exists.",
  ],
  [
    { kind: "emptyShell" },
    "no worktree inside",
    "Codex left this folder behind with no worktree inside.",
  ],
] as const)("an orphan folder is Orphaned and removable: %j", (cause, status, reason) => {
  const row = orphanRow({
    path: "/Users/me/.codex/worktrees/abcd/app",
    cause: cause as OrphanCause,
  });
  expect(assess(row)).toEqual({ status, verdict: "Orphaned", reason, removalBlockReason: null });
  expect([row.verdict, row.reason]).toEqual(["Orphaned", reason]);
});

test("an orphan is judged by its cause alone, whatever its Git fields or agent mark say", () => {
  const row = orphanRow({ path: "/Users/me/.codex/worktrees/abcd", cause: { kind: "emptyShell" } });
  const now = Date.parse(base.createdAt);
  expect(
    assess({ ...row, prunable: true, marker: "🤖", markerSetAt: base.createdAt }, now),
  ).toEqual(assess(row, now));
});

// Merge dates read in local time.
const zone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "UTC";
});
afterAll(() => {
  process.env.TZ = zone;
});

describe("a forge check", () => {
  const tip = "3f2c9a1e4b7d6c5a8f0e1d2c3b4a59687f6e5d4c";
  const mergedAt = "2026-10-27T15:00:00Z";
  const unmerged: Partial<WorktreeFacts> = {
    headSha: tip,
    mainAhead: 2,
    integrationReason: null,
    createdAt: createdBefore(60_000),
  };
  const proven = (
    by: "commit" | "tree" | "stacked",
    update: { tip?: string; mergedAt?: string } = {},
  ): ForgeCheck => ({ kind: "proven", tip, pr: 60, mergedAt, base: "main", by, ...update });
  const forged = (forge: ForgeCheck | undefined, update: Partial<WorktreeFacts> = {}) =>
    assess({ ...base, ...unmerged, mainState: "ahead", ...update, forge }, now);

  const states = [
    ["ahead", "unmerged commits", "2 commits aren't in origin/main."],
    [
      "would_conflict",
      "unmerged commits",
      "2 commits aren't in origin/main, and merging would conflict.",
    ],
    ["diverged", "unmerged commits", "2 commits aren't in origin/main, which has also moved on."],
    [
      "behind",
      "behind main",
      "origin/main has moved ahead, and Worktrunk didn't confirm this branch is in it.",
    ],
  ] as const;
  const unproven: [string, ForgeCheck | undefined, string | null][] = [
    ["absent", undefined, null],
    ["pending", { kind: "pending" }, "Checking GitHub…"],
    ["offline", { kind: "unchecked", why: "offline" }, "Not checked against GitHub: offline."],
    [
      "gh-missing",
      { kind: "unchecked", why: "gh-missing" },
      "Not checked against GitHub: gh isn't installed.",
    ],
    [
      "signed-out",
      { kind: "unchecked", why: "signed-out" },
      "Not checked against GitHub: gh isn't signed in.",
    ],
    ["no-github-remote", { kind: "unchecked", why: "no-github-remote" }, null],
    [
      "failed",
      { kind: "unchecked", why: "failed" },
      "Not checked against GitHub: GitHub didn't answer.",
    ],
    ["not-found", { kind: "not-found", tip }, "No merged pull request on GitHub has this commit."],
    [
      "not-found with a same-named PR",
      { kind: "not-found", tip, samePr: { number: 27, mergedAt: "2026-10-26T09:00:00Z" } },
      "PR #27 merged Oct 26 without this commit.",
    ],
  ];

  describe.each(states)("on a %s worktree", (mainState, status, first) => {
    test.each(unproven)("%s keeps it in Review", (_label, forge, note) => {
      expect(forged(forge, { mainState })).toEqual({
        status,
        verdict: "Review",
        reason: note ? `${first} ${note}` : first,
        removalBlockReason: null,
      });
    });

    test.each([
      ["commit", "PR #60 merged Oct 27 with this exact commit."],
      ["tree", "PR #60 merged Oct 27 with the same files."],
      ["stacked", "PR #60 merged Oct 27 and brought in this commit from a stacked pull request."],
    ] as const)("proven by %s makes it Safe", (by, reason) => {
      expect(forged(proven(by), { mainState })).toEqual({
        status: "merged on GitHub",
        verdict: "Safe",
        reason,
        removalBlockReason: null,
      });
    });
  });

  test("a proven worktree is Safe at any age", () => {
    for (const createdAt of [createdBefore(60_000), createdBefore(MIN_AGE_MS), null])
      expect(forged(proven("commit"), { createdAt }).verdict).toBe("Safe");
  });

  test("a proven branch without a worktree is Safe only once a day old", () => {
    const at = (createdAt: string | null) =>
      assess(
        { ...leftover, ...unmerged, mainState: "diverged", createdAt, forge: proven("tree") },
        now,
      );
    expect(at(createdBefore(MIN_AGE_MS))).toEqual({
      status: "merged on GitHub",
      verdict: "Safe",
      reason: "PR #60 merged Oct 27 with the same files.",
      removalBlockReason: null,
    });
    expect(at(createdBefore(2 * 3_600_000))).toEqual({
      status: "merged on GitHub",
      verdict: "Review",
      reason: "Created 2h ago, so it may still be in use.",
      removalBlockReason: null,
    });
    expect([at(null).verdict, at(null).reason]).toEqual([
      "Review",
      "Its creation time is unknown, so it may still be in use.",
    ]);
  });

  test("a recent agent mark turns a proven row back into Review", () => {
    const worktree = forged(proven("commit"), marked("🤖", 20 * 60_000));
    expect([worktree.status, worktree.verdict, worktree.reason]).toEqual([
      "merged on GitHub",
      "Review",
      "An agent was working here 20m ago.",
    ]);
    const branchRow = assess(
      {
        ...leftover,
        ...unmerged,
        ...marked("💬", null),
        createdAt: createdBefore(MIN_AGE_MS),
        forge: proven("commit"),
      },
      now,
    );
    expect([branchRow.verdict, branchRow.reason]).toEqual([
      "Review",
      "An agent was waiting for input here; when is unknown.",
    ]);
    expect(forged(proven("commit"), marked("🤖", 2 * MIN_AGE_MS)).verdict).toBe("Safe");
  });

  test.each([
    ["uncommitted changes", { changes: { ...base.changes!, modified: true } }],
    ["unpushed commits", { upstreamAhead: 1 }],
    ["locked", { locked: true, lockReason: "manual" }],
    ["rebase in progress", { operation: "rebase" }],
    ["unresolved conflicts", { changes: { ...base.changes!, conflicted: true } }],
    ["folder missing", { prunable: true }],
  ] as const)("%s outranks a proven check", (status, update) => {
    const result = forged(proven("commit"), update);
    expect(result.status).toBe(status);
    expect(result).toEqual(forged(undefined, update));
  });

  test.each(["integrated", "empty", "same_commit", "orphan", null])(
    "a %p main state ignores the forge check",
    (mainState) => {
      for (const forge of [proven("commit"), { kind: "not-found", tip } as const])
        expect(forged(forge, { mainState })).toEqual(forged(undefined, { mainState }));
    },
  );

  test("a check about another commit is ignored", () => {
    const other = "0".repeat(40);
    expect(forged(proven("commit", { tip: other }))).toEqual(forged(undefined));
    expect(forged({ kind: "not-found", tip: other })).toEqual(forged(undefined));
    expect(forged(proven("commit"), { headSha: null })).toEqual(
      forged(undefined, { headSha: null }),
    );
  });

  test("dates read in local time, with the year when it isn't this one", () => {
    expect(forged(proven("commit", { mergedAt: "2025-12-30T10:00:00Z" })).reason).toBe(
      "PR #60 merged Dec 30, 2025 with this exact commit.",
    );
    expect(forged(proven("commit", { mergedAt: "not a date" })).reason).toBe(
      "PR #60 merged with this exact commit.",
    );
    process.env.TZ = "Asia/Tokyo";
    try {
      expect(forged(proven("commit", { mergedAt: "2026-10-27T20:00:00Z" })).reason).toBe(
        "PR #60 merged Oct 28 with this exact commit.",
      );
    } finally {
      process.env.TZ = "UTC";
    }
  });
});

describe("assessRow", () => {
  const tip = "3f2c9a1e4b7d6c5a8f0e1d2c3b4a59687f6e5d4c";
  const row: WorktreeRow = {
    ...base,
    headSha: tip,
    mainState: "ahead",
    mainAhead: 1,
    sizeKiB: 2048,
    sizeMeasuredAt: "2026-10-28T11:00:00Z",
    verdict: "Review",
    reason: "1 commit isn't in origin/main.",
  };

  test("recomputes the verdict and reason from the facts and keeps the rest", () => {
    const pending = { ...row, forge: { kind: "pending" } as const };
    expect(assessRow(pending, now)).toEqual({
      ...pending,
      reason: "1 commit isn't in origin/main. Checking GitHub…",
    });
    expect(pending.reason).toBe("1 commit isn't in origin/main.");
  });

  test("settles a row once a forge proof arrives", () => {
    const forge: ForgeCheck = {
      kind: "proven",
      tip,
      pr: 60,
      mergedAt: "2026-10-27T15:00:00Z",
      base: "main",
      by: "commit",
    };
    expect(assessRow({ ...row, forge }, now)).toEqual({
      ...row,
      forge,
      verdict: "Safe",
      reason: "PR #60 merged Oct 27 with this exact commit.",
    });
  });

  test("gives facts without a row the verdict and reason assess gives them", () => {
    const facts: WorktreeFacts = { ...base, mainState: "diverged" };
    const { verdict, reason } = assess(facts, now);
    expect(assessRow(facts, now)).toEqual({ ...facts, verdict, reason });
  });
});
