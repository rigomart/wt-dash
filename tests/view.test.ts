import { expect, test } from "bun:test";
import { groupByRepo, selectRows } from "../src/core/view";
import type { WorktreeRow } from "../src/core/types";

function row(id: string, update: Partial<WorktreeRow> = {}): WorktreeRow {
  return {
    id,
    repoPath: "/repos/alpha",
    repoName: "alpha",
    path: `/worktrees/${id}`,
    branch: id,
    headSha: id,
    committedAt: "2026-09-28T00:00:00Z",
    createdAt: "2026-09-27T00:00:00Z",
    kind: "worktree",
    marker: null,
    markerSetAt: null,
    tool: "Claude",
    changes: {
      staged: false,
      modified: false,
      untracked: false,
      renamed: false,
      deleted: false,
      conflicted: false,
    },
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
    sizeKiB: 10,
    sizeMeasuredAt: null,
    verdict: "Safe",
    reason: "Integrated",
    ...update,
  };
}

test("searches branch and path without case sensitivity and combines filters", () => {
  const rows = [
    row("one", { branch: "Feature/API", repoName: "alpha", tool: "Codex", verdict: "Review" }),
    row("two", {
      path: "/tmp/API notes",
      repoName: "beta",
      repoPath: "/repos/beta",
      tool: "Claude",
      verdict: "Review",
    }),
    row("three", { branch: "feature/api", repoName: "alpha", tool: "Claude", verdict: "Safe" }),
  ];
  expect(
    selectRows(rows, {
      search: "api",
      verdicts: ["Review"],
      repos: ["alpha"],
      tools: ["Codex"],
    }).map((item) => item.id),
  ).toEqual(["one"]);
  expect(selectRows(rows, { search: "NOTES" }).map((item) => item.id)).toEqual(["two"]);
});

test("searches the name a tool is shown by (#43)", () => {
  const rows = [
    row("one", { tool: "Claude" }),
    row("two", { tool: "ClaudeSquad" }),
    row("three", { tool: "Gemini" }),
  ];
  const found = (search: string) => selectRows(rows, { search }).map((item) => item.id);
  expect(found("claude code")).toEqual(["one"]);
  expect(found("claude squad")).toEqual(["two"]);
  expect(found("gemini cli")).toEqual(["three"]);
});

test("defaults to largest first and keeps unknown sizes last", () => {
  const rows = [row("a", { sizeKiB: null }), row("b", { sizeKiB: 4 }), row("c", { sizeKiB: 20 })];
  expect(selectRows(rows, {}).map((item) => item.id)).toEqual(["c", "b", "a"]);
  expect(rows.map((item) => item.id)).toEqual(["a", "b", "c"]);
});

test("sorts age, repository and verdict with stable id ties", () => {
  const rows = [
    row("z", {
      committedAt: "2026-09-27T00:00:00Z",
      repoName: "beta",
      repoPath: "/repos/beta",
      verdict: "Review",
    }),
    row("a", { committedAt: "2026-09-28T00:00:00Z", repoName: "alpha", verdict: "Safe" }),
    row("b", { committedAt: "2026-09-28T00:00:00Z", repoName: "alpha", verdict: "Busy" }),
  ];
  expect(
    selectRows(rows, { sort: { key: "age", direction: "desc" } }).map((item) => item.id),
  ).toEqual(["z", "a", "b"]);
  expect(
    selectRows(rows, { sort: { key: "repo", direction: "asc" } }).map((item) => item.id),
  ).toEqual(["a", "b", "z"]);
  expect(
    selectRows(rows, { sort: { key: "verdict", direction: "asc" } }).map((item) => item.id),
  ).toEqual(["a", "z", "b"]);
});

test("groups selected rows in their displayed order", () => {
  const rows = [
    row("b", { repoName: "beta", repoPath: "/repos/beta" }),
    row("a"),
    row("c", { repoName: "beta", repoPath: "/repos/beta" }),
  ];
  expect(
    groupByRepo(rows).map((group) => [group.repoName, group.rows.map((item) => item.id)]),
  ).toEqual([
    ["beta", ["b", "c"]],
    ["alpha", ["a"]],
  ]);
});
