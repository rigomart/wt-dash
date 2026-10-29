import { describe, expect, test } from "bun:test";
import { assess, markerNote, MIN_AGE_MS } from "../src/core/assess";
import { parseWorktrunk } from "../src/core/worktrunk";
import fixture from "./fixtures/list-v2.json";
import type { ChangeFlags, WorktreeFacts } from "../src/core/types";

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
