import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/list-v2.json";
import { parseWorktrunk, SchemaMismatchError, toolForPath } from "../src/core/worktrunk";

const repo = "/Users/test/projects/sample";

describe("toolForPath", () => {
  test("attributes known tool directories and treats everything else as Other", () => {
    expect(toolForPath("/Users/test/p/.claude/worktrees/a")).toBe("Claude");
    expect(toolForPath("/Users/test/.codex/worktrees/a")).toBe("Codex");
    expect(toolForPath("/Users/test/.cache/other-tool/a")).toBe("Other");
  });
});

describe("parseWorktrunk", () => {
  test("keeps non-main worktrees including detached HEAD and full paths", () => {
    const rows = parseWorktrunk(repo, JSON.stringify(fixture));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.branch, row.path, row.tool, row.verdict])).toEqual([
      ["feature/name", "/Users/test/projects/sample/.claude/worktrees/a space", "Claude", "Safe"],
      [null, "/Users/test/.codex/worktrees/abc/sample", "Codex", "Review"],
    ]);
    expect(rows[1]?.id).toContain("/Users/test/.codex/worktrees/abc/sample");
  });

  test("rejects unsupported schema and malformed JSON", () => {
    expect(() => parseWorktrunk(repo, JSON.stringify({ ...fixture, schema: 1 }))).toThrow(
      SchemaMismatchError,
    );
    expect(() => parseWorktrunk(repo, "{")).toThrow();
  });

  test("preserves unknown optional status as null", () => {
    const rows = parseWorktrunk(repo, JSON.stringify(fixture));
    expect(rows[1]).toMatchObject({
      upstreamAhead: null,
      lockReason: null,
      mainAhead: null,
      defaultBranch: "main",
      mainBase: null,
      locked: false,
      operation: null,
      sizeKiB: null,
      sizeMeasuredAt: null,
    });
  });
});

test("preserves full lock reason and Worktrunk commit count", () => {
  const payload: any = structuredClone(fixture);
  payload.items[1].worktree.locked = {
    reason: "claude session example (pid 42 start Wed Sep 23 15:55:03 2026)",
  };
  payload.items[1].default_branch.ahead = 3;
  const row = parseWorktrunk(repo, JSON.stringify(payload))[0]!;
  expect(row).toMatchObject({
    lockReason: "claude session example (pid 42 start Wed Sep 23 15:55:03 2026)",
    mainAhead: 3,
    defaultBranch: "main",
  });
});

describe("branches without a worktree", () => {
  const payload: any = structuredClone(fixture);
  payload.items.push(
    {
      branch: "old-feature",
      head: { sha: "ddd", committed_at: "2026-09-20T00:00:00Z" },
      default_branch: { ahead: 0, behind: 3, integration: { reason: "ancestor" } },
      upstream: { ahead: 0, behind: 0 },
      display: { state: "integrated" },
    },
    // The default branch shows up here when no worktree has it checked out.
    { branch: "main", head: { sha: "aaa" }, display: { state: "is_main" } },
    { head: { sha: "eee" }, display: { state: "ahead" } },
  );

  test("become branch rows with no folder, and the default branch is left out", () => {
    const rows = parseWorktrunk(repo, JSON.stringify(payload));
    expect(rows.map((row) => [row.kind, row.branch])).toEqual([
      ["worktree", "feature/name"],
      ["worktree", null],
      ["branch", "old-feature"],
    ]);
    expect(rows[2]).toMatchObject({
      path: null,
      changes: null,
      headSha: "ddd",
      mainState: "integrated",
      integrationReason: "ancestor",
      upstreamAhead: 0,
      locked: false,
      prunable: false,
      operation: null,
    });
  });

  test("ids cannot collide with a worktree whose folder has the branch's name", () => {
    const same: any = structuredClone(payload);
    same.items[1].worktree.path = `${repo}/branch/old-feature`;
    const ids = parseWorktrunk(repo, JSON.stringify(same)).map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("keep Worktrunk's marker without a time, which the JSON does not carry", () => {
    const marked: any = structuredClone(payload);
    marked.items[1].marker = "🤖";
    expect(parseWorktrunk(repo, JSON.stringify(marked))[0]).toMatchObject({
      marker: "🤖",
      markerSetAt: null,
    });
  });
});
