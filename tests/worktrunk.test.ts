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
    expect(() => parseWorktrunk(repo, JSON.stringify({ ...fixture, schema: 1 }))).toThrow(SchemaMismatchError);
    expect(() => parseWorktrunk(repo, "{")).toThrow();
  });

  test("preserves unknown optional status as null", () => {
    const rows = parseWorktrunk(repo, JSON.stringify(fixture));
    expect(rows[1]).toMatchObject({
      upstreamAhead: null,
      lockReason: null, mainAhead: null, defaultBranch: "main", mainBase: null,
      locked: false,
      operation: null,
      sizeKiB: null,
      sizeMeasuredAt: null,
    });
  });
});

test('preserves full lock reason and Worktrunk commit count',()=>{
 const payload:any=structuredClone(fixture);
 payload.items[1].worktree.locked={reason:'claude session example (pid 42 start Wed Sep 23 15:55:03 2026)'};
 payload.items[1].default_branch.ahead=3;
 const row=parseWorktrunk(repo,JSON.stringify(payload))[0]!;
 expect(row).toMatchObject({lockReason:'claude session example (pid 42 start Wed Sep 23 15:55:03 2026)',mainAhead:3,defaultBranch:'main'});
});
