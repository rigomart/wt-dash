import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixture from "../fixtures/list-v2.json";
import { deleteOrphan } from "../../src/core/removal/orphan";
import { createActionService } from "../../src/core/removal/service";
import type { ActionService } from "../../src/core/removal/types";
import { orphanRow, readOrphanCause } from "../../src/core/scan/orphans";
import { ORPHANS, type WorktreeRow } from "../../src/core/types";
import { branchRow, fakeRepos, repo } from "./helpers";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const exists = (path: string) =>
  readdir(path).then(
    () => true,
    () => false,
  );

/** A Codex worktree at `<home>/.codex/worktrees/<id>/app` whose repository at `<root>/old/app` is gone. */
async function world(id = "abcd") {
  const root = await mkdtemp(join(tmpdir(), "dash-orphan-"));
  roots.push(root);
  const shell = join(root, "home", ".codex", "worktrees", id);
  const folder = join(shell, "app");
  const oldRepo = join(root, "old", "app");
  await mkdir(join(folder, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(folder, ".git"), `gitdir: ${oldRepo}/.git/worktrees/app\n`);
  await writeFile(join(folder, "node_modules", "pkg", "index.js"), "export {};\n");
  await writeFile(join(shell, ".codex-worktree-name"), "app\n");
  const { calls, runner } = fakeRepos({ payloads: {} });
  const logPath = join(root, "removals.log");
  const actions = createActionService({ wtPath: "/wt", runner, logPath });
  return { root, shell, folder, oldRepo, calls, logPath, actions, row: await shown(folder) };
}

async function shown(folder: string): Promise<WorktreeRow> {
  const cause = await readOrphanCause(folder);
  if (!cause) throw new Error(`${folder} is not an orphan`);
  return orphanRow({ path: folder, cause });
}

async function remove(
  actions: ActionService,
  rows: WorktreeRow[],
  between?: () => Promise<unknown>,
) {
  const plan = await actions.prepareRemoval(rows);
  await between?.();
  const progress: string[] = [];
  const result = await actions.executeRemoval(
    plan,
    Object.fromEntries(rows.map((row) => [row.id, { include: true }])),
    (id, status) => progress.push(`${id} ${status}`),
  );
  return { plan, result, progress };
}

const logLines = async (logPath: string) =>
  (await readFile(logPath, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

test("deletes an orphan and the Codex id folder it empties with the file system, and logs it, never running Git or Worktrunk", async () => {
  const { root, shell, folder, oldRepo, calls, logPath, actions, row } = await world();
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "keep.txt"), "keep\n");
  await symlink(outside, join(folder, "linked"));

  const { plan, result, progress } = await remove(actions, [row]);
  expect(plan.entries).toEqual([
    {
      row,
      blockedReason: null,
      localFiles: [],
      ignoredFiles: [],
      disposableIgnored: 0,
      requiresDiscard: false,
      branchWillBeRetained: false,
      folderId: expect.any(String),
    },
  ]);
  expect(result.items).toEqual([{ id: row.id, status: "removed" }]);
  expect(progress).toEqual([`${row.id} removing`, `${row.id} removed`]);
  expect([await exists(folder), await exists(shell), await exists(outside)]).toEqual([
    false,
    false,
    true,
  ]);
  expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("keep\n");
  expect(calls.filter((call) => call[0] !== "df")).toEqual([]);
  const [line] = await logLines(logPath);
  expect(line).toEqual({
    timestamp: expect.any(String),
    repo: oldRepo,
    branch: null,
    path: folder,
    flags: [],
    exitCode: null,
    branchOutcome: null,
    orphan: true,
    error: null,
  });
});

test("keeps the Codex id folder when anything but its name file is left, deletes one left empty, and deletes an empty shell itself", async () => {
  const { shell, folder, logPath, actions, row } = await world();
  await writeFile(join(shell, "notes.txt"), "mine\n");
  await remove(actions, [row]);
  expect([await exists(folder), await exists(shell)]).toEqual([false, true]);

  const bare = await world("ijkl");
  await rm(join(bare.shell, ".codex-worktree-name"));
  await remove(bare.actions, [bare.row]);
  expect([await exists(bare.folder), await exists(bare.shell)]).toEqual([false, false]);

  const { root, actions: others } = await world("efgh");
  const empty = join(root, "home", ".codex", "worktrees", "wxyz");
  await mkdir(empty);
  await writeFile(join(empty, ".codex-worktree-name"), "gone\n");
  await writeFile(join(empty, ".DS_Store"), "");
  const emptyRow = await shown(empty);
  expect(emptyRow.orphan).toEqual({ kind: "emptyShell" });
  expect((await remove(others, [emptyRow])).result.items).toEqual([
    { id: emptyRow.id, status: "removed" },
  ]);
  expect(await exists(empty)).toBe(false);
  expect((await logLines(logPath)).length).toBe(1);
});

test("a folder swapped in at the previewed path, even with the same stale link, is not deleted", async () => {
  const { root, shell, folder, actions, row } = await world();
  const away = join(root, "away");
  const { result } = await remove(actions, [row], async () => {
    await rename(shell, away);
    await mkdir(join(root, "copy", "app"), { recursive: true });
    await writeFile(join(root, "copy", "app", ".git"), await readFile(join(away, "app", ".git")));
    await symlink(join(root, "copy"), shell);
  });
  expect(result.items).toEqual([
    { id: row.id, status: "skipped", error: "it changed; refresh and preview again" },
  ]);
  expect([await exists(join(root, "copy", "app")), await exists(join(away, "app"))]).toEqual([
    true,
    true,
  ]);
  expect(folder).toBe(join(shell, "app"));
});

test("an empty shell is deleted without recursing, so a folder that appears in it stays", async () => {
  const { root } = await world();
  const empty = join(root, "home", ".codex", "worktrees", "wxyz");
  await mkdir(join(empty, "app"), { recursive: true });
  await writeFile(join(empty, ".codex-worktree-name"), "app\n");
  await expect(deleteOrphan(empty, { kind: "emptyShell" })).rejects.toThrow();
  expect(await exists(join(empty, "app"))).toBe(true);
});

test("the preview blocks an orphan that is gone, or that changed or stopped being one since it was shown", async () => {
  const gone = await world();
  await rm(gone.folder, { recursive: true });
  const changed = await world();
  await mkdir(changed.oldRepo, { recursive: true });
  const adopted = await world();
  await mkdir(join(adopted.oldRepo, ".git", "worktrees", "app"), { recursive: true });

  for (const [{ actions, row }, reason] of [
    [gone, "it is gone"],
    [changed, "it changed; refresh and preview again"],
    [adopted, "it changed; refresh and preview again"],
  ] as const) {
    const plan = await actions.prepareRemoval([row]);
    expect(plan.entries[0]?.blockedReason).toBe(reason);
  }
});

test("an orphan that changes after the preview is skipped and kept, and only an attempt is logged", async () => {
  const { folder, oldRepo, logPath, actions, row } = await world();
  const { result } = await remove(actions, [row], () => mkdir(oldRepo, { recursive: true }));
  expect(result.items).toEqual([
    { id: row.id, status: "skipped", error: "it changed; refresh and preview again" },
  ]);
  expect(await exists(folder)).toBe(true);
  expect(await logLines(logPath)).toEqual([]);
});

test("an orphan honors the batch's confirmation and stop like any row", async () => {
  const { folder, actions, row } = await world();
  let plan = await actions.prepareRemoval([row]);
  expect((await actions.executeRemoval(plan, { [row.id]: { include: false } })).items).toEqual([
    { id: row.id, status: "skipped", error: "Not confirmed" },
  ]);
  plan = await actions.prepareRemoval([row]);
  const stopped = await actions.executeRemoval(
    plan,
    { [row.id]: { include: true } },
    undefined,
    () => true,
  );
  expect(stopped.items).toEqual([{ id: row.id, status: "skipped", error: "Cancelled" }]);
  expect(await exists(folder)).toBe(true);
});

test("a batch with a worktree and an orphan removes the worktree through Worktrunk and prunes only its repo", async () => {
  const { root, folder } = await world();
  const { calls, runner } = fakeRepos({ payloads: { [repo]: fixture } });
  const actions = createActionService({ wtPath: "/wt", runner, logPath: join(root, "log") });
  const row = await shown(folder);
  const { result } = await remove(actions, [branchRow, row]);
  expect(result.items).toEqual([
    { id: branchRow.id, status: "removed", branchOutcome: "deleted" },
    { id: row.id, status: "removed" },
  ]);
  expect(calls.filter((call) => call.includes("remove")).map((call) => call.at(-1))).toEqual([
    branchRow.path!,
  ]);
  expect(calls.filter((call) => call.includes("prune"))).toEqual([
    ["git", "-C", repo, "worktree", "prune"],
  ]);
  expect(calls.some((call) => call.includes(ORPHANS) || call.includes(folder))).toBe(false);
});

test("never runs Git to inspect an orphan's files or prune the orphans group", async () => {
  const { calls, actions, row } = await world();
  await expect(actions.inspectFiles(row)).rejects.toThrow(
    "Git can't inspect an orphaned folder, because no repository knows it",
  );
  await expect(actions.preparePrune(ORPHANS)).rejects.toThrow(
    "Orphaned folders have no Git records to prune",
  );
  expect(calls).toEqual([]);
});
