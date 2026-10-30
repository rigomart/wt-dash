import { expect, test } from "bun:test";
import { dialog, inSandbox, lineWith, squeeze, withApp, TEST_TIMEOUT } from "../support/app";
import { startServer } from "../support/server";

for (const width of [120, 80] as const) {
  test(
    `at ${width} columns: a server running in a worktree shows in the strip, i and the remove dialog, and y stops it (#44)`,
    () =>
      inSandbox(async (sandbox) => {
        const alpha = await sandbox.repo("alpha");
        const serving = await alpha.squashMergedWorktree("serving");
        await alpha.squashMergedWorktree("idle");
        await (await sandbox.repo("beta")).squashMergedWorktree("other");
        const server = await startServer(serving.path!);
        try {
          await withApp(sandbox, { width, name: "processes" }, async (app) => {
            await app.settled();
            await app.press(width >= 100 ? "right" : "enter");
            await app.waitFor("space select  enter remove");
            await app.focus("idle");
            let frame = await app.waitFor("nothing uncommitted");
            expect(frame).not.toContain("1 process");

            await app.focus("serving");
            frame = await app.waitFor(`1 process · :${server.port}`);
            expect(lineWith(frame, "serving  ●"), "processes do not change the verdict").toContain(
              "● Safe",
            );

            await app.press("i");
            frame = await app.waitFor("↑↓ scroll  i back");
            expect(squeeze(lineWith(frame, "PROCESSES")).trim()).toMatch(
              new RegExp(`PROCESSES bun -e .* :${server.port}$`),
            );
            await app.press("i");
            await app.waitFor("space select  enter remove");

            await app.press("enter");
            frame = dialog(await app.waitFor("Remove 1 worktree"));
            expect(frame).toContain("Stops processes running inside  e leave them");
            expect(frame).toContain(`Running in serving: 1 process · :${server.port}`);
            await app.press("y");
            await app.waitFor("✓ Removed 1 worktree");
            const deadline = Date.now() + 5000;
            while (server.alive() && Date.now() < deadline) await Bun.sleep(50);
            expect(server.alive()).toBe(false);
          });
        } finally {
          await server.stop();
        }
      }),
    TEST_TIMEOUT,
  );
}
