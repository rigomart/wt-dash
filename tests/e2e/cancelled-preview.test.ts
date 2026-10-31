import { expect, test } from "bun:test";
import type { PrunePlan, RemovalPlan } from "../../src/core/removal/types";
import { exists, inSandbox, removals, rowOf, withApp, TEST_TIMEOUT } from "../support/app";
import { named, record } from "../support/runners";

for (const width of [120, 80]) {
  for (const key of ["enter", "x"]) {
    test(
      `#63: cancelled preview retry at ${width} columns: ${key} keeps the newer removal executable after the cancelled check completes`,
      () =>
        inSandbox(async (sandbox) => {
          const repo = await sandbox.repo("retry");
          const target = await repo.squashMergedWorktree("target");
          const recorder = record(sandbox.runner);
          try {
            await withApp(
              sandbox,
              { width, runner: recorder.runner, name: "cancelled removal preview" },
              async (app) => {
                try {
                  await app.settled();
                  await app.focus("target");
                  const prepare = app.services.actions.prepareRemoval;
                  let older: Promise<RemovalPlan> | undefined;
                  app.services.actions.prepareRemoval = (rows) => {
                    const pending = prepare(rows);
                    older ??= pending;
                    return pending;
                  };
                  const gate = recorder.gate(named("wt", "list"));
                  await app.press(key);
                  await gate.reached;
                  await app.waitFor("Checking 1 worktree");
                  await app.press("escape");
                  await app.waitFor("Cancelled");
                  expect(await exists(target.path!)).toBe(true);
                  expect(await removals(sandbox)).toEqual([]);

                  await app.press(key);
                  await app.waitFor("╭─ Remove 1 worktree");
                  gate.release();
                  await older;
                  expect(await app.frame()).toContain("╭─ Remove 1 worktree");
                  await app.press("y");
                  await app.waitFor("✓ Removed 1 worktree");
                  await app.waitFor((frame) => rowOf(frame, "target") === null);
                  expect(await exists(target.path!)).toBe(false);
                  expect(await repo.git("branch", "--list", "target")).toBe("");
                  expect(
                    (await removals(sandbox)).map(({ branch, exitCode, branchOutcome, flags }) => ({
                      branch,
                      exitCode,
                      branchOutcome,
                      flags,
                    })),
                  ).toEqual([
                    { branch: "target", exitCode: 0, branchOutcome: "deleted", flags: ["--reap"] },
                  ]);
                } finally {
                  recorder.releaseAll();
                }
              },
            );
          } finally {
            recorder.releaseAll();
          }
        }),
      TEST_TIMEOUT,
    );
  }

  test(
    `#63: cancelled preview retry at ${width} columns: Enter keeps the newer prune executable after the cancelled check completes`,
    () =>
      inSandbox(async (sandbox) => {
        const repo = await sandbox.repo("retry-prune");
        const target = await repo.deletedWorktree("missing");
        const recorder = record(sandbox.runner);
        try {
          await withApp(
            sandbox,
            { width, runner: recorder.runner, name: "cancelled prune preview" },
            async (app) => {
              try {
                await app.settled();
                await app.focus("missing");
                const prepare = app.services.actions.preparePrune;
                let older: Promise<PrunePlan> | undefined;
                app.services.actions.preparePrune = (path) => {
                  const pending = prepare(path);
                  older ??= pending;
                  return pending;
                };
                const gate = recorder.gate(named("git", "prune", "--dry-run"));
                await app.press("enter");
                await gate.reached;
                await app.waitFor("Checking retry-prune for missing worktrees");
                await app.press("escape");
                await app.waitFor("Cancelled");
                expect(await repo.git("worktree", "list", "--porcelain")).toContain(target.path!);
                await app.press("enter");
                await app.waitFor("Prune 1 missing worktree record in retry-prune?");
                gate.release();
                await older;
                expect(await app.frame()).toContain(
                  "Prune 1 missing worktree record in retry-prune?",
                );
                await app.press("y");
                await app.waitFor("✓ Pruned 1 record in retry-prune");
                expect(await repo.git("worktree", "list", "--porcelain")).not.toContain(
                  target.path!,
                );
                expect(await repo.git("branch", "--list", "missing")).toBe("missing");
                expect(await removals(sandbox)).toEqual([]);
              } finally {
                recorder.releaseAll();
              }
            },
          );
        } finally {
          recorder.releaseAll();
        }
      }),
    TEST_TIMEOUT,
  );
}
