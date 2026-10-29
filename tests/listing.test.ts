import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixture from "./fixtures/list-v2.json";
import { enrichRows, readBranchCreatedAt, readMarks } from "../src/core/listing";
import { parseWorktrunk } from "../src/core/worktrunk";
import type { CommandRunner } from "../src/core/types";

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
  await git("config", "worktrunk.state.feature/a.b.marker", '{"marker":"🤖","set_at":1790780978}');
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

test("a branch's age comes from its oldest reflog entry, else when its ref was written", async () => {
  await git("branch", "aged");
  const logPath = join(repo, ".git", "logs", "refs", "heads", "aged");
  const sha = await git("rev-parse", "aged");
  const zeros = "0".repeat(40);
  await Bun.write(
    logPath,
    `${zeros} ${sha} t <t@t> 1700000000 +0000\tbranch: Created from main\n` +
      `${sha} ${sha} t <t@t> 1790000000 +0200\tlater\n`,
  );
  expect(await readBranchCreatedAt(repo, "aged")).toBe(new Date(1700000000 * 1000).toISOString());

  await rm(logPath);
  const written = new Date("2026-10-01T00:00:00Z");
  await utimes(join(repo, ".git", "refs", "heads", "aged"), written, written);
  expect(await readBranchCreatedAt(repo, "aged")).toBe(written.toISOString());

  await Bun.write(logPath, "not a reflog line\n");
  expect(await readBranchCreatedAt(repo, "aged")).toBeNull();
  expect(await readBranchCreatedAt(join(directory, "missing"), "aged")).toBeNull();
});

test("enriching takes a branch's marker from Git config and a mark's time only when the markers agree", async () => {
  const payload: any = structuredClone(fixture);
  payload.items[1].marker = "💬";
  payload.items.push({
    branch: "left",
    head: { sha: "fff" },
    default_branch: { ahead: 0, behind: 1, integration: { reason: "ancestor" } },
    display: { state: "integrated" },
  });
  const setAt = new Date(Date.now() - 3_600_000).toISOString();
  const marks = `worktrunk.state.feature/name.marker\n{"marker":"🤖","set_at":${Date.parse(setAt) / 1000}}\0worktrunk.state.left.marker\n{"marker":"🤖","set_at":${Date.parse(setAt) / 1000}}\0`;
  const fake: CommandRunner = async (_command, args) =>
    args.includes("--get-regexp")
      ? { stdout: marks, stderr: "", exitCode: 0 }
      : { stdout: "", stderr: "", exitCode: 1 };
  const rows = await enrichRows(repo, parseWorktrunk(repo, JSON.stringify(payload)), fake, {
    readCreated: async () => "2026-09-01T00:00:00Z",
    readBranchCreated: async () => "2026-09-01T00:00:00Z",
  });
  expect(rows.map((row) => [row.branch, row.marker, row.markerSetAt, row.verdict])).toEqual([
    ["feature/name", "💬", null, "Review"],
    [null, null, null, "Review"],
    ["left", "🤖", setAt, "Review"],
  ]);
  expect(rows[2]!.reason).toBe("An agent was working here 1h ago.");
});
