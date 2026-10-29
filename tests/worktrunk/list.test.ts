import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixture from "../fixtures/list-v2.json";
import {
  parseWorktrunk,
  readMarks,
  SchemaMismatchError,
  toolForPath,
} from "../../src/core/worktrunk/list";
import type { CommandRunner } from "../../src/core/types";

const repo = "/Users/test/projects/sample";

describe("toolForPath", () => {
  const tool = (path: string) => toolForPath(path, repo);

  test("attributes known tool directories and treats everything else as Other", () => {
    expect(tool("/Users/test/p/.claude/worktrees/a")).toBe("Claude");
    expect(tool("/Users/test/.codex/worktrees/a")).toBe("Codex");
    expect(tool("/Users/test/.cache/other-tool/a")).toBe("Other");
  });

  test("attributes t3's current and old worktree folders to t3 (#43)", () => {
    expect(tool("/Users/test/.t3/worktrees/sample/feature-login")).toBe("t3");
    expect(tool("/Users/test/.t3-lines/lines/worktrees/sample/a")).toBe("t3");
  });

  test("attributes each agent tool's default worktree folder to it", () => {
    expect(tool("/Users/test/.cursor/worktrees/sample/k3x9")).toBe("Cursor");
    expect(tool("/Users/test/.cursor/worktrees/1a2b3c4d")).toBe("Cursor");
    expect(tool("/Users/test/conductor/workspaces/sample/nagoya")).toBe("Conductor");
    expect(tool("/Users/test/.windsurf/worktrees/sample/brave-otter")).toBe("Windsurf");
    expect(tool("/Users/test/projects/sample/.gemini/worktrees/my-feature")).toBe("Gemini");
    expect(tool("/Users/test/.claude-squad/worktrees/fix-login_18a2b3c4d5e6f708")).toBe(
      "ClaudeSquad",
    );
    expect(tool("/Users/test/.superset/worktrees/sample/add-auth")).toBe("Superset");
  });

  test("attributes Worktrunk's default `<repo>.<branch>` folder beside the repository to Worktrunk", () => {
    expect(tool("/Users/test/projects/sample.feature-auth")).toBe("Worktrunk");
    expect(tool("/Users/test/projects/sample-feature-auth")).toBe("Other");
    expect(tool("/Users/test/worktrees/sample.feature-auth")).toBe("Other");
  });

  test("attributes a worktree only to the tool whose folder it is, not to one it is nested in", () => {
    expect(tool("/Users/test/.t3/worktrees/sample/feature/sandbox/worktrees/a")).toBe("Other");
    expect(tool("/Users/test/.t3/worktrees/sample")).toBe("Other");
    expect(tool("/Users/test/conductor/workspaces/sample/nagoya/vendor/b")).toBe("Other");
    expect(tool("/Users/test/.codex/worktrees/1f04/sample/.gemini/worktrees/topic")).toBe("Gemini");
    expect(tool("/Users/test/p/.claude/worktrees/a/.gemini/worktrees/topic")).toBe("Gemini");
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

test("reads how far a branch is from main, the lines it changes, its latest subject and its vars", () => {
  const payload: any = structuredClone(fixture);
  payload.items[1].default_branch = { ahead: 3, behind: 2, diff: { added: 18, deleted: 4 } };
  expect(parseWorktrunk(repo, JSON.stringify(payload))[0]).toMatchObject({
    mainAhead: 3,
    mainBehind: 2,
    mainDiff: { added: 18, deleted: 4 },
    subject: "feature",
  });
  payload.items[1].vars = { task: "Rate limit the API", count: 3 };
  expect(parseWorktrunk(repo, JSON.stringify(payload))[0]).toMatchObject({
    vars: { task: "Rate limit the API" },
    description: null,
  });
  payload.items[1].vars = {};
  expect(parseWorktrunk(repo, JSON.stringify(payload))[0]!.vars).toBeNull();
  // A task that timed out leaves null, which reads as unknown rather than zero.
  payload.items[1].default_branch = { ahead: null, behind: null, diff: null };
  payload.items[1].head.subject = null;
  expect(parseWorktrunk(repo, JSON.stringify(payload))[0]).toMatchObject({
    mainAhead: null,
    mainBehind: null,
    mainDiff: null,
    subject: null,
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

describe("readMarks", () => {
  const runner: CommandRunner = async (command, args) => {
    const child = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  };

  let directory: string;
  let repo: string;
  async function git(...args: string[]): Promise<string> {
    const result = await runner("git", ["-C", repo, ...args]);
    if (result.exitCode !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "dash-listing-"));
    repo = join(directory, "repo");
    await runner("git", ["init", "-q", "-b", "main", repo]);
    await git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "a",
    );
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("reads Worktrunk's marks by branch, tolerating values that aren't its JSON", async () => {
    expect((await readMarks(repo, runner)).size).toBe(0);
    await git(
      "config",
      "worktrunk.state.feature/a.b.marker",
      '{"marker":"🤖","set_at":1790780978}',
    );
    await git("config", "worktrunk.state.waiting.marker", '{"marker":"💬"}');
    await git("config", "worktrunk.state.plain.marker", "✅");
    await git("config", "worktrunk.state.other.note", "ignored");
    expect(Object.fromEntries(await readMarks(repo, runner))).toEqual({
      "feature/a.b": { marker: "🤖", setAt: new Date(1790780978 * 1000).toISOString() },
      waiting: { marker: "💬", setAt: null },
      plain: { marker: "✅", setAt: null },
    });
  });

  test("a mark keeps its marker when its time is out of range", async () => {
    await git("config", "worktrunk.state.far.marker", '{"marker":"🤖","set_at":1e20}');
    expect((await readMarks(repo, runner)).get("far")).toEqual({ marker: "🤖", setAt: null });
    await git("config", "--unset", "worktrunk.state.far.marker");
  });

  test("config that can't be read gives no marks", async () => {
    const failing: CommandRunner = async () => {
      throw new Error("spawn failed");
    };
    expect((await readMarks(repo, failing)).size).toBe(0);
    expect((await readMarks(join(directory, "missing"), runner)).size).toBe(0);
  });
});
