import { expect, test } from "bun:test";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sizeLabel } from "../../src/ui/format";
import {
  dialog,
  dialogRow,
  exists,
  inSandbox,
  lineWith,
  listPart,
  removals,
  rowOf,
  squeeze,
  withApp,
  type App,
  TEST_TIMEOUT,
} from "../support/app";

const WIDTHS = [120, 80] as const;

const open = (app: App) => app.press(app.width >= 100 ? "right" : "enter");

for (const width of WIDTHS) {
  test(
    `at ${width} columns: Space selects, a takes only Safe rows, x previews sizes, Esc cancels, y removes`,
    () =>
      inSandbox(async (sandbox) => {
        const alpha = await sandbox.repo("alpha");
        const squashed = await alpha.squashMergedWorktree("squashed");
        const merged = await alpha.mergedWorktree("merged");
        const fresh = await alpha.freshWorktree("fresh");
        await (await sandbox.repo("beta")).squashMergedWorktree("done");
        await withApp(sandbox, { width, name: "select and remove" }, async (app) => {
          await app.settled();
          await open(app);
          let frame = await app.waitFor("space select  enter remove");
          const safeKiB = [squashed, merged].reduce(
            (sum, built) => sum + app.services.sizes.get(built.path!)!.sizeKiB,
            0,
          );

          frame = await app.focus("squashed");
          await app.press("space");
          frame = await app.waitFor((text) => rowOf(text, "squashed")?.startsWith("■ ") ?? false);
          expect(squeeze(listPart(lineWith(frame, "1 selected")))).toStartWith(
            `■ 1 selected · up to ${app.size(squashed)} `,
          );
          await app.press("space");
          frame = await app.waitFor((text) => rowOf(text, "squashed")?.startsWith("□ ") ?? false);
          expect(frame).not.toContain("selected ·");

          await app.press("a");
          frame = await app.waitFor(`✓ Selected 2 Safe worktrees · up to ${sizeLabel(safeKiB)}`);
          expect(rowOf(frame, "squashed")).toStartWith("■ ");
          expect(rowOf(frame, "merged")).toStartWith("■ ");
          expect(rowOf(frame, "fresh")).toStartWith("□ ");

          await app.press("x");
          frame = await app.waitFor(`Remove 2 worktrees · up to ${sizeLabel(safeKiB)}?`);
          expect(dialogRow(frame, "squashed")).toBe(`• squashed alpha ${app.size(squashed)}`);
          expect(dialogRow(frame, "merged")).toBe(`• merged alpha ${app.size(merged)}`);
          expect(dialogRow(frame, "fresh")).toBe("");
          expect(frame).toContain("Nothing uncommitted. Ignored files and caches go with them.");
          expect(frame).toContain("Merged branches are deleted.");
          expect(frame).toContain("Stops processes running inside  e leave them");

          await app.press("escape");
          frame = await app.waitFor((text) => !text.includes("╭─ Remove"));
          expect(rowOf(frame, "squashed")).toStartWith("■ ");
          expect(rowOf(frame, "merged")).toStartWith("■ ");
          expect(await exists(squashed.path!)).toBe(true);
          expect(await exists(merged.path!)).toBe(true);
          expect(await removals(sandbox)).toEqual([]);

          await app.press("x");
          await app.waitFor(`Remove 2 worktrees · up to ${sizeLabel(safeKiB)}?`);
          await app.press("y");
          frame = await app.waitFor(/✓ Removed 2 worktrees · (freed|up to) .+/);
          frame = await app.waitFor(
            (text) => rowOf(text, "squashed") === null && rowOf(text, "merged") === null,
          );
          expect(rowOf(frame, "fresh")).toStartWith("□ fresh no new commits ");
          expect(await exists(squashed.path!)).toBe(false);
          expect(await exists(merged.path!)).toBe(false);
          expect(await exists(fresh.path!)).toBe(true);
          expect(await alpha.git("branch", "--list", "squashed", "merged")).toBe("");
          const log = await removals(sandbox);
          expect(
            log
              .map(({ branch, flags, exitCode }) => ({ branch, flags, exitCode }))
              .sort((a, b) => String(a.branch).localeCompare(String(b.branch))),
          ).toEqual([
            { branch: "merged", flags: ["--reap"], exitCode: 0 },
            { branch: "squashed", flags: ["--reap"], exitCode: 0 },
          ]);

          await app.press("escape");
          frame = await app.waitFor(width >= 100 ? "→ worktrees" : "enter open");
          frame = await app.waitFor(/(^|\n)(▌ | {2})alpha +1 /);
        });
      }),
    TEST_TIMEOUT,
  );

  test(
    `at ${width} columns: r rescans and shows a worktree created after start`,
    () =>
      inSandbox(async (sandbox) => {
        const alpha = await sandbox.repo("alpha");
        await alpha.squashMergedWorktree("first");
        await alpha.squashMergedWorktree("second");
        const beta = await sandbox.repo("beta");
        await beta.squashMergedWorktree("done");
        await withApp(sandbox, { width, name: "rescan" }, async (app) => {
          let frame = await app.settled();
          expect(frame).toMatch(/(^|\n)(▌ | {2})beta +1 /);
          const late = await beta.squashMergedWorktree("late");
          await app.press("r");
          frame = await app.waitFor(/(^|\n)(▌ | {2})beta +2 /);
          frame = await app.settled();
          await app.press("down");
          await open(app);
          frame = await app.waitFor((text) => rowOf(text, "late") !== null);
          expect(lineWith(frame, "wt-dash")).toStartWith("wt-dash › beta");
          expect(rowOf(frame, "late")).toMatch(
            new RegExp(`^□ late merged .+ now ${app.size(late).replace(".", "\\.")}$`),
          );
          expect(rowOf(frame, "done")).not.toBeNull();
        });
      }),
    TEST_TIMEOUT,
  );

  test(
    `at ${width} columns: leftover branches read "branch", and D in the dialog deletes an unmerged one`,
    () =>
      inSandbox(async (sandbox) => {
        const alpha = await sandbox.repo("alpha");
        const worktree = await alpha.squashMergedWorktree("worktree");
        const merged = await alpha.mergedBranch("leftover");
        const unmerged = await alpha.unmergedBranch("open");
        await withApp(sandbox, { width, name: "leftover branches" }, async (app) => {
          let frame = await app.settled();
          expect(lineWith(frame, "wt-dash")).toStartWith("wt-dash › alpha");
          // AGE counts from the last commit, which both branch builders date 3 days back.
          expect(rowOf(frame, "leftover")).toBe(
            "□ leftover merged Its commits are already in main 3d branch",
          );
          expect(rowOf(frame, "open")).toBe(
            "□ open unmerged commits 1 commit isn't in main 3d branch",
          );
          expect(rowOf(frame, "worktree")).toEndWith(` ${app.size(worktree)}`);

          await app.focus("open");
          frame = await app.waitFor("Branch without a worktree · created 3d ago");
          await app.press("x");
          frame = await app.waitFor("Remove 1 branch · up to 0 KB?");
          expect(dialogRow(frame, "open")).toBe("• open alpha branch");
          expect(frame).toContain("! Skips open unless you press D: not merged, and no worktree");
          expect(frame).toContain("Keeps 1 unmerged branch  D delete too");
          await app.press("D");
          frame = await app.waitFor("Also deletes 1 unmerged branch  D keep them");
          expect(frame).not.toContain("unless you press D");
          await app.press("y");
          frame = await app.waitFor(/✓ Removed 1 branch · (freed|up to) .+/);
          frame = await app.waitFor((text) => rowOf(text, "open") === null);
          expect(rowOf(frame, "leftover")).not.toBeNull();
          expect(await alpha.git("branch", "--list", unmerged.branch)).toBe("");
          expect(await alpha.git("branch", "--list", merged.branch)).toBe("leftover");
          expect(
            (await removals(sandbox)).map(({ branch, path, flags, branchOutcome }) => ({
              branch,
              path,
              flags,
              branchOutcome,
            })),
          ).toEqual([{ branch: "open", path: null, flags: ["-D"], branchOutcome: "deleted" }]);
        });
      }),
    TEST_TIMEOUT,
  );
}

for (const width of WIDTHS) {
  test(
    `at ${width} columns: the dialog names ignored files that aren't caches, and says nothing of cache folders alone (#45)`,
    () =>
      inSandbox(async (sandbox) => {
        const alpha = await sandbox.repo("alpha");
        await appendFile(join(alpha.path, ".git", "info", "exclude"), ".env*\n*.db\n");
        const secrets = await alpha.squashMergedWorktree("secrets");
        for (const file of [".env.local", ".env.test", "dev.db"])
          await writeFile(join(secrets.path!, file), "secret\n");
        await mkdir(join(secrets.path!, "node_modules", "pkg"), { recursive: true });
        await writeFile(join(secrets.path!, "node_modules", "pkg", "index.js"), "export {};\n");
        const dotenv = await alpha.squashMergedWorktree("dotenv");
        await writeFile(join(dotenv.path!, ".env.local"), "secret\n");
        await alpha.sizedWorktree("caches", { kib: 64 });
        await (await sandbox.repo("beta")).squashMergedWorktree("other");
        await withApp(sandbox, { width, name: "ignored files" }, async (app) => {
          await app.settled();
          await open(app);
          await app.focus("secrets");
          await app.press("x");
          let frame = await app.waitFor("╭─ Remove");
          expect(squeeze(lineWith(dialog(frame), "! Deletes")).trim()).toBe(
            "│ ! Deletes ignored files in secrets: .env.local, .env.test +1 more │",
          );
          expect(dialog(frame)).not.toContain("node_modules");
          expect(dialog(frame)).toContain(
            "Nothing uncommitted. Ignored files and caches go with them.",
          );

          await app.press("escape");
          await app.waitFor((text) => !text.includes("╭─"));
          await app.focus("caches");
          await app.press("x");
          frame = await app.waitFor("╭─ Remove");
          expect(dialogRow(frame, "caches")).not.toBe("");
          expect(dialog(frame)).not.toContain("Deletes ignored files");
          expect(dialog(frame)).toContain(
            "Nothing uncommitted. Ignored files and caches go with them.",
          );

          await app.press("escape");
          await app.waitFor((text) => !text.includes("╭─"));
          await app.focus("secrets");
          await app.press("space");
          await app.waitFor((text) => rowOf(text, "secrets")?.startsWith("■ ") ?? false);
          for (const branch of ["caches", "dotenv"]) {
            await app.focus(branch);
            await app.press("space");
            await app.waitFor((text) => rowOf(text, branch)?.startsWith("■ ") ?? false);
          }
          await app.press("x");
          frame = await app.waitFor("╭─ Remove 3 worktrees");
          expect(squeeze(lineWith(dialog(frame), "! Deletes")).trim()).toBe(
            "│ ! Deletes ignored files in dotenv and secrets │",
          );
          expect(await exists(secrets.path!)).toBe(true);
        });
      }),
    TEST_TIMEOUT,
  );
}
