import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSizeService } from "../src/core/sizes";
import type { CommandRunner } from "../src/core/types";

const roots: string[] = [];
async function cachePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dash-size-"));
  roots.push(root);
  return join(root, "sizes.json");
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("limits concurrent du calls to two", async () => {
  let active = 0;
  let peak = 0;
  const runner: CommandRunner = async (_command, args) => {
    active++;
    peak = Math.max(peak, active);
    await Bun.sleep(10);
    active--;
    return { stdout: `20\t${args[1]}\n`, stderr: "", exitCode: 0 };
  };
  const sizes = createSizeService(await cachePath(), runner, 2);
  await sizes.load();
  const results = await Promise.all(["a", "b", "c", "d"].map((path) => sizes.measure(path)));
  expect(peak).toBe(2);
  expect(results.map((entry) => entry?.sizeKiB)).toEqual([20, 20, 20, 20]);
  await sizes.close();
});

test("loads a timestamped size and persists a new measurement for a path with spaces", async () => {
  const path = await cachePath();
  await writeFile(path, JSON.stringify({ "/old": { sizeKiB: 8, measuredAt: "2026-09-28T00:00:00Z" } }));
  const calls: string[][] = [];
  const runner: CommandRunner = async (_command, args) => {
    calls.push(args);
    return { stdout: "42\t/tmp/a space\n", stderr: "", exitCode: 0 };
  };
  const sizes = createSizeService(path, runner);
  await sizes.load();
  expect(sizes.get("/old")).toEqual({ sizeKiB: 8, measuredAt: "2026-09-28T00:00:00Z" });
  expect((await sizes.measure("/tmp/a space"))?.sizeKiB).toBe(42);
  expect(calls).toEqual([["-sk", "/tmp/a space"]]);
  expect(JSON.parse(await readFile(path, "utf8"))["/tmp/a space"].sizeKiB).toBe(42);
  await sizes.close();
});

test("missing or corrupt cache loads empty and failed du leaves size unknown", async () => {
  const path = await cachePath();
  const runner: CommandRunner = async () => ({ stdout: "", stderr: "denied", exitCode: 1 });
  const sizes = createSizeService(path, runner);
  await sizes.load();
  expect(sizes.get("/missing")).toBeNull();
  await writeFile(path, "not-json");
  await sizes.load();
  expect(sizes.get("/missing")).toBeNull();
  expect(await sizes.measure("/missing")).toBeNull();
  await sizes.close();
});

test("malformed du output does not replace an existing cached size", async () => {
  const path = await cachePath();
  await writeFile(path, JSON.stringify({ "/old": { sizeKiB: 8, measuredAt: "2026-09-28T00:00:00Z" } }));
  const sizes = createSizeService(path, async () => ({ stdout: "nope", stderr: "", exitCode: 0 }));
  await sizes.load();
  expect(await sizes.measure("/old")).toBeNull();
  expect(sizes.get("/old")?.sizeKiB).toBe(8);
  await sizes.close();
});

test("closing cancels a slow measurement and releases queued work", async () => {
  let aborted = 0;
  const runner: CommandRunner = async (_command, _args, signal) => new Promise((resolve) => {
    signal?.addEventListener("abort", () => {
      aborted++;
      resolve({ stdout: "", stderr: "aborted", exitCode: 1 });
    }, { once: true });
  });
  const sizes = createSizeService(await cachePath(), runner, 1);
  const first = sizes.measure("/slow");
  const queued = sizes.measure("/queued");
  await Bun.sleep(0);
  await Promise.race([
    sizes.close(),
    Bun.sleep(100).then(() => { throw new Error("close waited for du"); }),
  ]);
  expect(await first).toBeNull();
  expect(await queued).toBeNull();
  expect(aborted).toBe(1);
});
