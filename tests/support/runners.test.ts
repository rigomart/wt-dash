import { expect, test, setDefaultTimeout } from "bun:test";
import { inSandbox } from "./app";
import { named, record } from "./runners";
import { TEST_TIMEOUT } from "./fixture";

setDefaultTimeout(TEST_TIMEOUT);

const ok = { exitCode: 0, stdout: "", stderr: "" };

/** How `promise` settles within `ms`: its value, its error's message, or "stuck". */
async function settles(promise: Promise<unknown>, ms = 3000): Promise<unknown> {
  let timer: Timer | undefined;
  const stuck = new Promise((resolve) => (timer = setTimeout(resolve, ms, "stuck")));
  try {
    return await Promise.race([promise.catch((error: Error) => error.message), stuck]);
  } finally {
    clearTimeout(timer);
  }
}

test("a held command throws like an aborted one when its signal aborts", async () => {
  const recorder = record(async () => ok);
  const gate = recorder.gate(named("du"));
  const controller = new AbortController();
  const held = recorder.runner("du", ["-sk", "/x"], controller.signal);
  expect((await gate.reached).args).toEqual(["-sk", "/x"]);
  controller.abort();
  expect(await settles(held)).toBe("Command aborted");
  expect(await recorder.runner("du", ["-sk", "/y"])).toEqual(ok);
});

test("releaseAll lets every held command run, and passes gates no command reached yet", async () => {
  const recorder = record(async () => ok);
  const first = recorder.gate(named("git"));
  recorder.gate(named("wt"));
  const held = recorder.runner("git", ["status"]);
  await first.reached;
  recorder.releaseAll();
  expect(await settles(held)).toEqual(ok);
  expect(await settles(recorder.runner("wt", ["list"]))).toEqual(ok);
  expect(recorder.count(() => true)).toBe(2);
});

test(
  "services.close() completes while a du is held",
  () =>
    inSandbox(async (sandbox) => {
      const built = await (await sandbox.repo("alpha")).squashMergedWorktree("held");
      const recorder = record(sandbox.runner);
      const du = recorder.gate(named("du", built.path!));
      try {
        const { sizes, close } = await sandbox.services({ runner: recorder.runner });
        const measured = sizes.measureIfStale(built.path!);
        await du.reached;
        expect(await settles(close().then(() => "closed"))).toBe("closed");
        expect(await measured).toBeNull();
        expect(sizes.get(built.path!)).toBeNull();
      } finally {
        recorder.releaseAll();
      }
    }),
  15_000,
);
