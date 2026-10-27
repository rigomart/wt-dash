import { describe, expect, test } from "bun:test";
import { verdictFor } from "../src/core/verdict";
import type { ChangeFlags, WorktreeFacts } from "../src/core/types";

const cleanChanges: ChangeFlags = {
  staged: false,
  modified: false,
  untracked: false,
  renamed: false,
  deleted: false,
  conflicted: false,
};
const clean: WorktreeFacts = {
  id: "repo\0path",
  repoPath: "/repo",
  repoName: "repo",
  path: "/repo/worktree",
  branch: "feature",
  headSha: "abc",
  committedAt: "2026-09-28T00:00:00Z",
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

describe("verdictFor", () => {
  test("Busy outranks Broken", () => {
    expect(verdictFor({ ...clean, prunable: true, operation: "rebase" }).verdict).toBe("Busy");
  });

  test.each([
    ["lock", { locked: true }],
    ["local edits", { changes: { ...cleanChanges, modified: true } }],
    ["untracked files", { changes: { ...cleanChanges, untracked: true } }],
    ["upstream commits", { upstreamAhead: 2 }],
    ["unknown main state", { mainState: null }],
  ] as const)("%s needs review", (_label, update) => {
    expect(verdictFor({ ...clean, ...update }).verdict).toBe("Review");
  });

  test("clean integrated and empty worktrees are Safe", () => {
    expect(verdictFor(clean).verdict).toBe("Safe");
    expect(verdictFor({ ...clean, mainState: "empty" }).verdict).toBe("Safe");
  });
});
