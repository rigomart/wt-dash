import { expect, test } from "bun:test";
import { inSandbox, withApp, TEST_TIMEOUT } from "../support/app";
import { named, record } from "../support/runners";

for (const width of [120, 80]) {
  for (const activity of ["scanning", "sizing", "toast"] as const) {
    test(
      `file details load during ${activity} at ${width} columns (audit #4)`,
      () =>
        inSandbox(async (sandbox) => {
          const repo = await sandbox.repo("alpha");
          await repo.sizedWorktree("clean", { kib: 1024 });
          const dirty = await repo.dirtyWorktree("dirty");
          const beta = await sandbox.repo("beta");
          await beta.freshWorktree("other");
          const recorder = record(sandbox.runner);
          const gate =
            activity === "sizing"
              ? recorder.gate(named("du", dirty.path!))
              : activity === "scanning"
                ? recorder.gate(named("wt", "list", beta.path))
                : null;
          await withApp(
            sandbox,
            { width, runner: recorder.runner, name: "inspect-ticks" },
            async (app) => {
              try {
                if (gate) await gate.reached;
                else await app.settled();
                await app.press(width >= 100 ? "right" : "enter");
                if (activity === "toast") {
                  await app.press("v");
                  await app.waitFor("Grouping by repo works in the all-projects view");
                }
                await app.focus("dirty");
                let frame = await app.waitFor("uncommitted  README.md  notes.txt", {
                  timeout: 1500,
                });
                expect(frame).not.toContain("checking files…");
                const active =
                  activity === "scanning"
                    ? "scanning"
                    : activity === "sizing"
                      ? "1 sizing"
                      : "Grouping by repo works";
                expect(frame).toContain(active);
                await app.press("i");
                frame = await app.waitFor("UNCOMMITTED   README.md  notes.txt", { timeout: 1500 });
                expect(frame).toContain(active);
              } finally {
                recorder.releaseAll();
              }
            },
          );
        }),
      TEST_TIMEOUT,
    );
  }
}
