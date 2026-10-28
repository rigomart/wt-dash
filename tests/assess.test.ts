import { expect, test } from "bun:test";
import { assess, MIN_AGE_MS } from "../src/core/assess";
import { parseWorktrunk } from "../src/core/worktrunk";
import fixture from "./fixtures/list-v2.json";
import type { WorktreeFacts } from "../src/core/types";

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

test.each(["🤖", "💬", "✅"])(
  "agent marker %s does not affect Git cleanup eligibility",
  (marker) => {
    const payload = structuredClone(fixture);
    Object.assign(payload.items[1]!, { marker });
    const result = assess(parseWorktrunk("/repo", JSON.stringify(payload))[0]!);
    expect(result.verdict).toBe("Safe");
    expect(result.removalBlockReason).toBeNull();
  },
);
