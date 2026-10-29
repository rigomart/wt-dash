import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixture from "../fixtures/list-v2.json";
import { enrichRows } from "../../src/core/scan/enrich";
import { parseWorktrunk } from "../../src/core/worktrunk/list";
import type { CommandRunner } from "../../src/core/types";

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
