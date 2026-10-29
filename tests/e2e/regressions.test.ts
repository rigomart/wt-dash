import { expect, test } from "bun:test";
import { stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { sizeLabel } from "../../src/ui/format";
import {
  dialog,
  dialogRow,
  exists,
  inSandbox,
  lineWith,
  removals,
  rowOf,
  sectionOf,
  withApp,
  type App,
  TEST_TIMEOUT,
} from "../support/app";
import { createSandbox, OLD_AGE_MS, type Built, type Repo, type Sandbox } from "../support/fixture";
import { named, record } from "../support/runners";

test(
  "#19/#21: the remove dialog and the result show the measured size, not … or 0 KB",
  () =>
    inSandbox(async (sandbox) => {
      const repo = await sandbox.repo("alpha");
      const built = await repo.sizedWorktree("sq", { kib: 3072 });
      const recorder = record(sandbox.runner);
      recorder.override(named("df"), { exitCode: 1, stdout: "", stderr: "df: unavailable" });
      await withApp(sandbox, { width: 120, runner: recorder.runner, name: "B1" }, async (app) => {
        let frame = await app.settled();
        const size = app.size(built);
        expect(app.services.sizes.get(built.path!)!.sizeKiB).toBeGreaterThanOrEqual(3072);
        expect(rowOf(frame, "sq")).toEndWith(` ${size}`);
        await app.press("x");
        frame = await app.waitFor("╭─ Remove");
        expect(lineWith(frame, "╭─")).toContain(` Remove 1 worktree · up to ${size}? `);
        expect(dialogRow(frame, "sq")).toBe(`• sq alpha ${size}`);
        expect(dialog(frame)).not.toContain("0 KB");
        expect(dialog(frame)).not.toContain("…");
        await app.press("y");
        frame = await app.waitFor(/[✓!✗] (Removed|Removal)/);
        expect(frame).toContain(`✓ Removed 1 worktree · up to ${size} freed`);
        expect(await exists(built.path!)).toBe(false);
        expect(await repo.git("branch", "--list", "sq")).toBe("");
        expect(recorder.count(named("df"))).toBe(2);
      });
    }),
  TEST_TIMEOUT,
);

test(
  "#21: the remove dialog says how many rows are still sizing, then shows the size once du returns",
  () =>
    inSandbox(async (sandbox) => {
      const repo = await sandbox.repo("alpha");
      const built = await repo.sizedWorktree("sq", { kib: 1024 });
      const recorder = record(sandbox.runner);
      const du = recorder.gate(named("du", built.path!));
      await withApp(sandbox, { width: 80, runner: recorder.runner, name: "B2" }, async (app) => {
        try {
          await du.reached;
          let frame = await app.waitFor((text) => rowOf(text, "sq") !== null);
          expect(rowOf(frame, "sq")).toEndWith(" …");
          await app.press("x");
          frame = await app.waitFor("╭─ Remove");
          expect(lineWith(frame, "╭─")).toContain(" Remove 1 worktree · 1 sizing? ");
          expect(dialogRow(frame, "sq")).toBe("• sq alpha …");
          expect(dialog(frame)).not.toContain("0 KB");
          du.release();
          frame = await app.waitFor(function titleWithoutSizing(text) {
            return !lineWith(text, "╭─").includes("sizing");
          });
          const size = app.size(built);
          expect(size).not.toBe("…");
          expect(lineWith(frame, "╭─")).toContain(` Remove 1 worktree · up to ${size}? `);
          expect(dialogRow(frame, "sq")).toBe(`• sq alpha ${size}`);
          await app.press("escape");
          await app.waitFor((text) => !text.includes("╭─"));
        } finally {
          recorder.releaseAll();
        }
        expect(await exists(built.path!)).toBe(true);
      });
    }),
  TEST_TIMEOUT,
);

/** A `sleep 300` in `folder` with no controlling terminal. */
function sleeper(folder: string): Subprocess {
  return Bun.spawn(
    ["perl", "-MPOSIX", "-e", 'setsid; chdir shift or die; exec "sleep", "300"', folder],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

test(
  "#21: removal stops processes running inside by default, and e leaves them running",
  async () => {
    const sleepers: Subprocess[] = [];
    try {
      await inSandbox(async (sandbox) => {
        const repo = await sandbox.repo("alpha");
        const first = await repo.squashMergedWorktree("first");
        const second = await repo.squashMergedWorktree("second");
        const [one, two] = [sleeper(first.path!), sleeper(second.path!)];
        sleepers.push(one, two);
        await withApp(sandbox, { width: 120, name: "B3" }, async (app) => {
          await app.settled();
          expect(alive(one.pid) && alive(two.pid)).toBe(true);

          await app.focus("first");
          await app.press("x");
          let frame = await app.waitFor("╭─ Remove 1 worktree");
          expect(dialogRow(frame, "first")).toStartWith("• first alpha ");
          expect(frame).toContain("Stops processes running inside  e leave them");
          await app.press("y");
          frame = await app.waitFor(/[✓!✗] (Removed|Removal)/);
          expect(frame).toContain("✓ Removed 1 worktree · ");
          await Promise.race([one.exited, Bun.sleep(5000)]);
          expect(alive(one.pid)).toBe(false);
          expect(await exists(first.path!)).toBe(false);
          let log = await removals(sandbox);
          expect(log.map(({ branch, flags }) => ({ branch, flags }))).toEqual([
            { branch: "first", flags: ["--reap"] },
          ]);

          await app.focus("second");
          await app.press("x");
          frame = await app.waitFor("╭─ Remove 1 worktree");
          expect(dialogRow(frame, "second")).toStartWith("• second alpha ");
          await app.press("e");
          frame = await app.waitFor("Processes inside keep running  e stop them");
          await app.press("y");
          frame = await app.waitFor(/[✓!✗] (Removed|Removal)/);
          expect(frame).toContain("✓ Removed 1 worktree · ");
          expect(await exists(second.path!)).toBe(false);
          log = await removals(sandbox);
          expect(log.map(({ branch, flags }) => ({ branch, flags }))).toEqual([
            { branch: "first", flags: ["--reap"] },
            { branch: "second", flags: [] },
          ]);
          expect(alive(two.pid)).toBe(true);
          expect(two.exitCode).toBeNull();
        });
      });
    } finally {
      for (const child of sleepers) child.kill("SIGKILL");
      await Promise.all(sleepers.map((child) => child.exited));
    }
  },
  TEST_TIMEOUT,
);

const backdates = await (async () => {
  const probe = await createSandbox();
  await probe.cleanup();
  return probe.backdatesOnDisk;
})();

/**
 * A worktree with no new commits, created `OLD_AGE_MS` ago, which Git has written to since, as any reset or
 * checkout does. Only file systems where backdating moves the birth time (macOS) can make one.
 */
async function oldUntouchedWorktree(sandbox: Sandbox, repo: Repo, branch: string) {
  const path = join(sandbox.root, "worktrees", `${repo.name}.${branch}`);
  await repo.git("worktree", "add", "-q", "-b", branch, path, "main");
  const gitdir = (await sandbox.git(path, "rev-parse", "--absolute-git-dir")).trim();
  const old = new Date(Date.now() - OLD_AGE_MS);
  await utimes(gitdir, old, old);
  await sandbox.git(path, "reset", "-q", "--hard");
  const { birthtimeMs, mtimeMs } = await stat(gitdir);
  if (Date.now() - birthtimeMs < OLD_AGE_MS / 2 || Date.now() - mtimeMs > 60_000)
    throw new Error(`${gitdir} should be born long ago and written to just now`);
  return path;
}

async function expectSafeSelected(
  app: App,
  safe: Array<{ branch: string; path: string }>,
  fresh: Built,
) {
  const kib = safe.reduce((sum, { path }) => sum + app.services.sizes.get(path)!.sizeKiB, 0);
  await app.press("a");
  let frame = await app.waitFor("Selected");
  expect(frame).toContain(`✓ Selected ${safe.length} Safe worktrees · up to ${sizeLabel(kib)}`);
  for (const { branch } of safe) expect(rowOf(frame, branch)).toStartWith("■ ");
  expect(rowOf(frame, "fresh")).toStartWith("□ ");
  await app.press("x");
  frame = await app.waitFor("╭─ Remove");
  expect(lineWith(frame, "╭─")).toContain(
    ` Remove ${safe.length} worktrees · up to ${sizeLabel(kib)}? `,
  );
  expect(dialogRow(frame, "fresh")).toBe("");
  expect(await exists(fresh.path!)).toBe(true);
}

test(
  "#16: a selects the Safe worktrees but not one created just now with no new commits",
  () =>
    inSandbox(async (sandbox) => {
      const repo = await sandbox.repo("alpha");
      const squashed = await repo.squashMergedWorktree("squashed");
      const merged = await repo.mergedWorktree("merged");
      const fresh = await repo.freshWorktree("fresh");
      await withApp(sandbox, { width: 120, name: "B4" }, async (app) => {
        const frame = await app.settled();
        expect(sectionOf(frame, "squashed")).toBe("SAFE");
        expect(sectionOf(frame, "merged")).toBe("SAFE");
        expect(sectionOf(frame, "fresh")).toBe("REVIEW");
        expect(rowOf(frame, "fresh")).toStartWith("□ fresh no new commits Created just now, so it");
        await expectSafeSelected(
          app,
          [squashed, merged].map(({ branch, path }) => ({ branch, path: path! })),
          fresh,
        );
      });
    }),
  TEST_TIMEOUT,
);

test.skipIf(!backdates)(
  "#16: a also selects a worktree with no new commits created days ago, though Git wrote to it just now",
  () =>
    inSandbox(async (sandbox) => {
      const repo = await sandbox.repo("alpha");
      const squashed = await repo.squashMergedWorktree("squashed");
      const fresh = await repo.freshWorktree("fresh");
      const old = await oldUntouchedWorktree(sandbox, repo, "old");
      await withApp(sandbox, { width: 120, name: "B4 old" }, async (app) => {
        const frame = await app.settled();
        expect(sectionOf(frame, "old")).toBe("SAFE");
        expect(rowOf(frame, "old")).toStartWith("□ old no new commits No commits beyond main ");
        expect(sectionOf(frame, "fresh")).toBe("REVIEW");
        await expectSafeSelected(
          app,
          [
            { branch: "squashed", path: squashed.path! },
            { branch: "old", path: old },
          ],
          fresh,
        );
      });
    }),
  TEST_TIMEOUT,
);

for (const width of [120, 80]) {
  test(
    `#23 at ${width} columns: the dialog says a dirty worktree's branch that main moved past is deleted, and y deletes it`,
    () =>
      inSandbox(async (sandbox) => {
        const repo = await sandbox.repo("alpha");
        const built = await repo.dirtyWorktree("behind");
        await repo.git("commit", "-q", "--allow-empty", "-m", "Main moves on");
        await withApp(sandbox, { width, name: "#23" }, async (app) => {
          await app.settled();
          await app.press(width >= 100 ? "right" : "enter");
          await app.waitFor("space select  enter remove");
          await app.focus("behind");
          await app.press("x");
          let frame = await app.waitFor("╭─ Remove");
          expect(dialog(frame)).toContain("! Discards uncommitted changes in behind");
          expect(dialog(frame)).toContain("Merged branches are deleted.");
          expect(dialog(frame)).not.toContain("unmerged");
          await app.press("y");
          frame = await app.waitFor(/[✓!✗] (Removed|Removal)/);
          expect(frame).toContain("✓ Removed 1 worktree");
          expect(await exists(built.path!)).toBe(false);
          expect(await repo.git("branch", "--list", "behind")).toBe("");
          expect(
            (await removals(sandbox)).map(({ branch, flags, branchOutcome }) => ({
              branch,
              flags,
              branchOutcome,
            })),
          ).toEqual([{ branch: "behind", flags: ["-f", "--reap"], branchOutcome: "deleted" }]);
        });
      }),
    TEST_TIMEOUT,
  );
}
