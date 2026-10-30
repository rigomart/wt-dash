import { afterAll, beforeAll, expect, test, setDefaultTimeout } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assess } from "../../src/core/assess";
import { ORPHANS, type DashboardSnapshot, type WorktreeRow } from "../../src/core/types";
import { createSandbox, type Repo, type Sandbox, TEST_TIMEOUT } from "../support/fixture";
import { exists, waitFor } from "./helpers";

setDefaultTimeout(TEST_TIMEOUT);

interface CodexWorktree {
  repo: string;
  shell: string;
  path: string;
}

let sandbox: Sandbox;
let gone: CodexWorktree;
let live: CodexWorktree;
let removed: CodexWorktree;
let changed: CodexWorktree;
let emptyShell: string;
let scanned: Repo;
let pruned: string;

async function codexWorktree(
  id: string,
  name: string,
  deleteRepo: boolean,
): Promise<CodexWorktree> {
  const repo = join(sandbox.root, "elsewhere", name);
  const shell = join(sandbox.home, ".codex", "worktrees", id);
  const path = join(shell, "app");
  await mkdir(repo, { recursive: true });
  await sandbox.git(repo, "init", "-q");
  await writeFile(join(repo, "README.md"), `# ${name}\n`);
  await sandbox.git(repo, "add", "README.md");
  await sandbox.git(repo, "commit", "-q", "-m", "Initial commit");
  await mkdir(shell, { recursive: true });
  await writeFile(join(shell, ".codex-worktree-name"), "app\n");
  await sandbox.git(repo, "worktree", "add", "-q", "-b", `codex-${id}`, path);
  await writeFile(join(path, "build.bin"), randomBytes(512 * 1024));
  if (deleteRepo) await rm(repo, { recursive: true });
  return { repo, shell, path };
}

beforeAll(async () => {
  sandbox = await createSandbox();
  [gone, live, removed, changed] = await Promise.all([
    codexWorktree("abcd", "gone", true),
    codexWorktree("live", "live", false),
    codexWorktree("wxyz", "removed", true),
    codexWorktree("mnop", "changed", true),
  ]);
  emptyShell = join(sandbox.home, ".codex", "worktrees", "efgh");
  await mkdir(emptyShell, { recursive: true });
  await writeFile(join(emptyShell, ".codex-worktree-name"), "finished\n");
  scanned = await sandbox.repo("kept");
  pruned = join(scanned.path, ".claude", "worktrees", "fix");
  await scanned.git("worktree", "add", "-q", "-b", "fix", pruned);
  await rm(join(scanned.path, ".git", "worktrees", "fix"), { recursive: true });
}, 30_000);

afterAll(() => sandbox?.cleanup());

async function fullScan(): Promise<{
  snapshot: DashboardSnapshot;
  services: Awaited<ReturnType<Sandbox["services"]>>;
}> {
  const services = await sandbox.services();
  await services.dashboard.refresh();
  const snapshot = services.dashboard.getSnapshot();
  expect(snapshot.progress.phase).toBe("complete");
  return { snapshot, services };
}

function orphan(snapshot: DashboardSnapshot, path: string): WorktreeRow {
  const found = snapshot.rows.find((row) => row.kind === "orphan" && row.path === path);
  if (!found) throw new Error(`no orphan row for ${path}`);
  return found;
}

test("lists a Codex worktree whose repository was deleted, with its size and the missing repository", async () => {
  const { snapshot, services } = await fullScan();
  const row = orphan(snapshot, gone.path);
  expect(row).toMatchObject({
    id: `${ORPHANS}\0${gone.path}`,
    repoPath: ORPHANS,
    tool: "Codex",
    verdict: "Orphaned",
    reason: `Its repository at ${gone.repo} no longer exists.`,
  });
  expect(assess(row).status).toBe("repository gone");
  const sized = await waitFor(
    services.dashboard,
    (next) => (next.rows.find((item) => item.id === row.id)?.sizeKiB ?? 0) >= 512,
  );
  expect(sized.repos.map((repo) => repo.path)).toEqual([scanned.path]);
});

test("lists a Codex id folder holding only its name file", async () => {
  const { snapshot } = await fullScan();
  const row = orphan(snapshot, emptyShell);
  expect([assess(row).status, row.reason]).toEqual([
    "no worktree inside",
    "Codex left this folder behind with no worktree inside.",
  ]);
});

test("does not list a live worktree of a repository outside the scan folders, or its Codex id folder", async () => {
  const { snapshot } = await fullScan();
  expect(snapshot.rows.filter((row) => row.path?.startsWith(live.shell))).toEqual([]);
  expect(await exists(live.path)).toBe(true);
});

test("lists a Claude worktree inside a scanned repository whose record was pruned as unknown to its repo", async () => {
  const { snapshot } = await fullScan();
  const row = orphan(snapshot, pruned);
  expect([assess(row).status, row.reason, row.tool]).toEqual([
    "unknown to its repo",
    `Its repository at ${scanned.path} no longer lists it.`,
    "Claude",
  ]);
  expect(snapshot.errors).toEqual({});
});

test("removing an orphan deletes its folder and the emptied Codex id folder, logs it, and a rescan drops it", async () => {
  const { snapshot, services } = await fullScan();
  const row = orphan(snapshot, removed.path);
  const plan = await services.actions.prepareRemoval([row]);
  expect(plan.entries[0]?.blockedReason).toBeNull();
  const result = await services.actions.executeRemoval(plan, { [row.id]: { include: true } });
  expect(result.items).toEqual([{ id: row.id, status: "removed" }]);
  expect([await exists(removed.path), await exists(removed.shell)]).toEqual([false, false]);
  const log = (await readFile(join(sandbox.cacheDir, "removals.log"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((line) => line.path === removed.path);
  expect(log).toEqual([
    {
      timestamp: expect.any(String),
      repo: removed.repo,
      branch: null,
      path: removed.path,
      flags: [],
      exitCode: null,
      branchOutcome: null,
      orphan: true,
      error: null,
    },
  ]);
  await services.dashboard.refresh([ORPHANS]);
  const after = services.dashboard.getSnapshot();
  expect(after.rows.some((item) => item.id === row.id)).toBe(false);
  expect(after.rows.some((item) => item.path === gone.path)).toBe(true);
  expect(after.errors).toEqual({});
});

test("skips and keeps an orphan whose repository came back between preview and removal", async () => {
  const { snapshot, services } = await fullScan();
  const row = orphan(snapshot, changed.path);
  const plan = await services.actions.prepareRemoval([row]);
  expect(plan.entries[0]?.blockedReason).toBeNull();
  await mkdir(changed.repo, { recursive: true });
  const result = await services.actions.executeRemoval(plan, { [row.id]: { include: true } });
  expect(result.items).toEqual([
    { id: row.id, status: "skipped", error: "it changed; refresh and preview again" },
  ]);
  expect(await exists(changed.path)).toBe(true);
});
