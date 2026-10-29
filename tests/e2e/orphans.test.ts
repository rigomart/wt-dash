import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  dialog,
  exists,
  inSandbox,
  lineWith,
  listPart,
  removals,
  rowOf,
  squeeze,
  withApp,
  TEST_TIMEOUT,
} from "../support/app";
import type { Sandbox } from "../support/fixture";

/** Of the folders arranged, only `abcd/app` and `ef01` are orphans; `9a9a/lib` is live. */
async function arrangeOrphans(sandbox: Sandbox) {
  const codex = join(sandbox.home, ".codex", "worktrees");
  const old = join(sandbox.home, "old", "app");
  await mkdir(old, { recursive: true });
  await sandbox.git(old, "init", "-q", "-b", "main");
  await sandbox.git(old, "commit", "-q", "--allow-empty", "-m", "init");
  const shell = join(codex, "abcd");
  await mkdir(shell, { recursive: true });
  await writeFile(join(shell, ".codex-worktree-name"), "app\n");
  await sandbox.git(old, "worktree", "add", "-q", "-b", "codex/abcd", join(shell, "app"));
  await writeFile(join(shell, "app", "build.bin"), new Uint8Array(256 * 1024));
  await rm(old, { recursive: true });

  const empty = join(codex, "ef01");
  await mkdir(empty, { recursive: true });
  await writeFile(join(empty, ".codex-worktree-name"), "");

  const lib = join(sandbox.home, "elsewhere", "lib");
  await mkdir(lib, { recursive: true });
  await sandbox.git(lib, "init", "-q", "-b", "main");
  await sandbox.git(lib, "commit", "-q", "--allow-empty", "-m", "init");
  await sandbox.git(lib, "worktree", "add", "-q", "-b", "codex/9a9a", join(codex, "9a9a", "lib"));
  return { shell, app: join(shell, "app"), empty, live: join(codex, "9a9a", "lib") };
}

test(
  "lists orphaned folders last in the projects, opens them, removes one through the dialog, and a rescan drops it",
  () =>
    inSandbox(async (sandbox) => {
      await (await sandbox.repo("alpha")).squashMergedWorktree("done");
      const orphans = await arrangeOrphans(sandbox);
      await withApp(sandbox, { width: 120, name: "orphaned folders" }, async (app) => {
        let frame = await app.settled();
        const entries = frame
          .split("\n")
          .map((line) => /^(?:▌ | {2})(alpha|Orphaned folders) +(\d+)/u.exec(line))
          .filter((match) => match !== null)
          .map((match) => `${match[1]} ${match[2]}`);
        expect(entries).toEqual(["alpha 1", "Orphaned folders 2"]);
        expect(frame).not.toContain("lib");

        await app.press("escape");
        await app.waitFor("→ worktrees");
        await app.press("down");
        frame = await app.waitFor(/^▌ Orphaned folders +2/mu);
        await app.press("right");
        frame = await app.waitFor("○ ORPHANED");
        expect(squeeze(listPart(lineWith(frame, "○ ORPHANED")))).toStartWith(
          "○ ORPHANED 2 orphaned folders",
        );
        expect(rowOf(frame, "abcd/app")).toStartWith(
          "□ abcd/app repository gone Its repository at ~/",
        );
        expect(rowOf(frame, "ef01")).toStartWith("□ ef01 no worktree inside ");
        expect(frame).not.toContain("lib");

        await app.focus("abcd/app");
        await app.press("space");
        await app.waitFor((text) => rowOf(text, "abcd/app")?.startsWith("■ ") ?? false);
        await app.press("enter");
        frame = await app.waitFor("Remove 1 orphaned folder");
        expect(dialog(frame)).toContain(
          "No repository tracks abcd/app, so wt-dash deletes it itself, unchecked,",
        );
        expect(dialog(frame)).not.toContain("ef01");
        await app.press("y");
        frame = await app.waitFor("Removed 1 orphaned folder");
        await app.waitFor((text) => rowOf(text, "abcd/app") === null);
        expect([await exists(orphans.app), await exists(orphans.shell)]).toEqual([false, false]);
        expect(await exists(orphans.empty)).toBe(true);
        expect(await exists(orphans.live)).toBe(true);
        const last = (await removals(sandbox)).at(-1);
        expect(last).toMatchObject({
          path: orphans.app,
          branch: null,
          flags: [],
          orphan: true,
          error: null,
        });

        await app.press("r");
        await app.settled();
        frame = await app.waitFor((text) => rowOf(text, "ef01") !== null);
        expect(rowOf(frame, "abcd/app")).toBeNull();
        expect(rowOf(frame, "ef01")).toStartWith("□ ef01 no worktree inside ");
        expect(await exists(orphans.app)).toBe(false);
      });
    }),
  TEST_TIMEOUT,
);
