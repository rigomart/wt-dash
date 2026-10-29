import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBranchCreatedAt, readComparisonBase } from "../../src/core/git/refs";
import type { CommandRunner } from "../../src/core/types";
const ok = (stdout = "") => ({ stdout, stderr: "", exitCode: 0 });
test.each([
  ["0\t2", "origin/main"],
  ["0\t0", "main"],
  ["1\t2", "main"],
  ["2\t0", "main"],
])("comparison base for divergence %s is %s", async (counts, want) => {
  const runner: CommandRunner = async (_command, args) =>
    ok(args.includes("rev-parse") ? "refs/remotes/origin/main\n" : counts);
  expect(await readComparisonBase("/repo", "main", runner)).toBe(want);
});
test("comparison base falls back to default branch without upstream", async () => {
  expect(await readComparisonBase("/repo", "main", async () => ({ ...ok(), exitCode: 1 }))).toBe(
    "main",
  );
});

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
