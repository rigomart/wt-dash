import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSizeService, SIZE_MAX_AGE_MS } from "../src/core/sizes";
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
  await writeFile(
    path,
    JSON.stringify({ "/old": { sizeKiB: 8, measuredAt: "2026-09-28T00:00:00Z" } }),
  );
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
  await writeFile(
    path,
    JSON.stringify({ "/old": { sizeKiB: 8, measuredAt: "2026-09-28T00:00:00Z" } }),
  );
  const sizes = createSizeService(path, async () => ({ stdout: "nope", stderr: "", exitCode: 0 }));
  await sizes.load();
  expect(await sizes.measure("/old")).toBeNull();
  expect(sizes.get("/old")?.sizeKiB).toBe(8);
  await sizes.close();
});

test("closing cancels a slow measurement and releases queued work", async () => {
  let aborted = 0;
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const runner: CommandRunner = async (_command, _args, signal) =>
    new Promise((resolve) => {
      started();
      signal?.addEventListener(
        "abort",
        () => {
          aborted++;
          resolve({ stdout: "", stderr: "aborted", exitCode: 1 });
        },
        { once: true },
      );
    });
  const sizes = createSizeService(await cachePath(), runner, 1);
  const first = sizes.measure("/slow");
  const queued = sizes.measure("/queued");
  await running;
  await Promise.race([
    sizes.close(),
    Bun.sleep(100).then(() => {
      throw new Error("close waited for du");
    }),
  ]);
  expect(await first).toBeNull();
  expect(await queued).toBeNull();
  expect(aborted).toBe(1);
});

function gatedRunner() {
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  let running = 0;
  const watchers: Array<[number, () => void]> = [];
  let peak = 0;
  const runner: CommandRunner = async (_command, args) => {
    started.push(args[1]!);
    for (const [count, wake] of watchers) if (started.length >= count) wake();
    running++;
    peak = Math.max(peak, running);
    await new Promise<void>((resolve) => gates.set(args[1]!, resolve));
    running--;
    return { stdout: `20\t${args[1]}\n`, stderr: "", exitCode: 0 };
  };
  const reached = (count: number) =>
    started.length >= count
      ? Promise.resolve()
      : new Promise<void>((resolve) => watchers.push([count, resolve]));
  return { runner, started, gates, reached, peak: () => peak };
}

function startedSorted(fake: { started: string[] }): string[] {
  return [...fake.started].sort();
}

test("defaults to six concurrent du calls", async () => {
  const fake = gatedRunner();
  const sizes = createSizeService(await cachePath(), fake.runner);
  await sizes.load();
  const paths = Array.from({ length: 8 }, (_, index) => `/p${index}`);
  const results = paths.map((path) => sizes.measure(path));
  await fake.reached(6);
  await Bun.sleep(0);
  expect(startedSorted(fake)).toEqual(paths.slice(0, 6));
  fake.gates.get("/p0")!();
  await fake.reached(7);
  await Bun.sleep(0);
  expect(startedSorted(fake)).toEqual(paths.slice(0, 7));
  for (const [index, path] of paths.entries()) {
    await fake.reached(index + 1);
    fake.gates.get(path)!();
  }
  await Promise.all(results);
  expect(fake.peak()).toBe(6);
  await sizes.close();
});

test("uncached paths get a slot before earlier-queued cached paths, FIFO within each class", async () => {
  const path = await cachePath();
  const entry = { sizeKiB: 8, measuredAt: "2026-09-28T00:00:00Z" };
  await writeFile(path, JSON.stringify({ "/c1": entry, "/c2": entry }));
  const fake = gatedRunner();
  const sizes = createSizeService(path, fake.runner, 1);
  await sizes.load();
  const results = ["/busy", "/c1", "/u1", "/c2", "/u2"].map((target) => sizes.measure(target));
  await fake.reached(1);
  await Bun.sleep(0);
  expect(fake.started).toEqual(["/busy"]);
  const order = ["/busy", "/u1", "/u2", "/c1", "/c2"];
  for (const [index, target] of order.entries()) {
    await fake.reached(index + 1);
    fake.gates.get(target)!();
  }
  await Promise.all(results);
  expect(fake.started).toEqual(["/busy", "/u1", "/u2", "/c1", "/c2"]);
  expect(fake.peak()).toBe(1);
  await sizes.close();
});

test("closing releases waiters in both queues", async () => {
  const path = await cachePath();
  await writeFile(
    path,
    JSON.stringify({ "/cached": { sizeKiB: 8, measuredAt: "2026-09-28T00:00:00Z" } }),
  );
  const runner: CommandRunner = async (_command, _args, signal) =>
    new Promise((resolve) => {
      signal?.addEventListener(
        "abort",
        () => resolve({ stdout: "", stderr: "aborted", exitCode: 1 }),
        { once: true },
      );
    });
  const sizes = createSizeService(path, runner, 1);
  await sizes.load();
  const results = ["/slow", "/cached", "/uncached"].map((target) => sizes.measure(target));
  await Bun.sleep(0);
  await Promise.race([
    sizes.close(),
    Bun.sleep(100).then(() => {
      throw new Error("close left a waiter hanging");
    }),
  ]);
  expect(await Promise.all(results)).toEqual([null, null, null]);
});

async function worktreeWithFixedMtime(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dash-tree-"));
  roots.push(root);
  await utimes(root, 1_000, 1_000);
  return root;
}

function countingRunner() {
  const calls: string[] = [];
  const runner: CommandRunner = async (_command, args) => {
    calls.push(args[1]!);
    return { stdout: `20\t${args[1]}\n`, stderr: "", exitCode: 0 };
  };
  return { runner, calls };
}

function clock(start = "2026-10-01T00:00:00Z") {
  let time = Date.parse(start);
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

test("a fresh saved size skips du, also after a restart", async () => {
  const path = await cachePath();
  const dir = await worktreeWithFixedMtime();
  const fake = countingRunner();
  const time = clock();
  const first = createSizeService(path, fake.runner, 6, time.now);
  await first.load();
  expect((await first.measure(dir))?.signature).toEqual({
    mtimeMs: 1_000_000,
    nodeModulesMtimeMs: null,
  });
  expect(await first.measureIfStale(dir)).toBeNull();
  await first.close();
  const second = createSizeService(path, fake.runner, 6, time.now);
  await second.load();
  expect(await second.measureIfStale(dir)).toBeNull();
  expect(second.get(dir)?.sizeKiB).toBe(20);
  expect(fake.calls).toEqual([dir]);
  await second.close();
});

test("a saved size 24 hours old is measured again", async () => {
  const dir = await worktreeWithFixedMtime();
  const fake = countingRunner();
  const time = clock();
  const sizes = createSizeService(await cachePath(), fake.runner, 6, time.now);
  await sizes.measure(dir);
  time.advance(SIZE_MAX_AGE_MS - 1);
  expect(await sizes.measureIfStale(dir)).toBeNull();
  time.advance(1);
  expect((await sizes.measureIfStale(dir))?.measuredAt).toBe("2026-10-02T00:00:00.000Z");
  expect(fake.calls).toEqual([dir, dir]);
  await sizes.close();
});

test("a changed worktree folder mtime is measured again", async () => {
  const dir = await worktreeWithFixedMtime();
  const fake = countingRunner();
  const sizes = createSizeService(await cachePath(), fake.runner, 6, clock().now);
  await sizes.measure(dir);
  await utimes(dir, 2_000, 2_000);
  expect((await sizes.measureIfStale(dir))?.signature?.mtimeMs).toBe(2_000_000);
  expect(await sizes.measureIfStale(dir)).toBeNull();
  expect(fake.calls).toEqual([dir, dir]);
  await sizes.close();
});

test("node_modules appearing, changing or disappearing is measured again", async () => {
  const dir = await worktreeWithFixedMtime();
  const modules = join(dir, "node_modules");
  const fake = countingRunner();
  const sizes = createSizeService(await cachePath(), fake.runner, 6, clock().now);
  await sizes.measure(dir);
  await mkdir(modules);
  await utimes(modules, 3_000, 3_000);
  await utimes(dir, 1_000, 1_000);
  expect((await sizes.measureIfStale(dir))?.signature).toEqual({
    mtimeMs: 1_000_000,
    nodeModulesMtimeMs: 3_000_000,
  });
  expect(await sizes.measureIfStale(dir)).toBeNull();
  await utimes(modules, 4_000, 4_000);
  expect((await sizes.measureIfStale(dir))?.signature?.nodeModulesMtimeMs).toBe(4_000_000);
  await rm(modules, { recursive: true });
  await utimes(dir, 1_000, 1_000);
  expect((await sizes.measureIfStale(dir))?.signature?.nodeModulesMtimeMs).toBeNull();
  expect(fake.calls).toEqual([dir, dir, dir, dir]);
  await sizes.close();
});

test("an old cache entry without a signature is shown but measured again", async () => {
  const path = await cachePath();
  const dir = await worktreeWithFixedMtime();
  await writeFile(
    path,
    JSON.stringify({ [dir]: { sizeKiB: 8, measuredAt: "2026-09-30T23:00:00Z" } }),
  );
  const fake = countingRunner();
  const sizes = createSizeService(path, fake.runner, 6, clock().now);
  await sizes.load();
  expect(sizes.get(dir)).toEqual({ sizeKiB: 8, measuredAt: "2026-09-30T23:00:00Z" });
  expect((await sizes.measureIfStale(dir))?.sizeKiB).toBe(20);
  expect(fake.calls).toEqual([dir]);
  expect(JSON.parse(await readFile(path, "utf8"))[dir].signature).toEqual({
    mtimeMs: 1_000_000,
    nodeModulesMtimeMs: null,
  });
  await sizes.close();
});

test("a worktree that cannot be checked is measured again", async () => {
  const path = await cachePath();
  const missing = join(await worktreeWithFixedMtime(), "gone");
  const signature = { mtimeMs: 1_000_000, nodeModulesMtimeMs: null };
  await writeFile(
    path,
    JSON.stringify({ [missing]: { sizeKiB: 8, measuredAt: "2026-10-01T00:00:00Z", signature } }),
  );
  const fake = countingRunner();
  const sizes = createSizeService(path, fake.runner, 6, clock().now);
  await sizes.load();
  expect(sizes.get(missing)?.signature).toEqual(signature);
  await sizes.measureIfStale(missing);
  expect(fake.calls).toEqual([missing]);
  await sizes.close();
});

test("measure always runs du, even for a fresh saved size", async () => {
  const dir = await worktreeWithFixedMtime();
  const fake = countingRunner();
  const sizes = createSizeService(await cachePath(), fake.runner, 6, clock().now);
  await sizes.measure(dir);
  expect(await sizes.measureIfStale(dir)).toBeNull();
  await sizes.measure(dir);
  expect(fake.calls).toEqual([dir, dir]);
  await sizes.close();
});

test("a fresh saved size does not wait for a busy slot", async () => {
  const dir = await worktreeWithFixedMtime();
  const time = clock();
  const seed = createSizeService(await cachePath(), countingRunner().runner, 6, time.now);
  await seed.measure(dir);
  const fake = gatedRunner();
  const path = await cachePath();
  await writeFile(path, JSON.stringify({ [dir]: seed.get(dir) }));
  await seed.close();
  const sizes = createSizeService(path, fake.runner, 1, time.now);
  await sizes.load();
  const busy = sizes.measure("/busy");
  await fake.reached(1);
  expect(await sizes.measureIfStale(dir)).toBeNull();
  fake.gates.get("/busy")!();
  await busy;
  expect(fake.started).toEqual(["/busy"]);
  await sizes.close();
});

test("a stale saved size still queues behind paths with no saved size", async () => {
  const path = await cachePath();
  await writeFile(
    path,
    JSON.stringify({ "/stale": { sizeKiB: 8, measuredAt: "2026-09-28T00:00:00Z" } }),
  );
  const fake = gatedRunner();
  const sizes = createSizeService(path, fake.runner, 1, clock().now);
  await sizes.load();
  const busy = sizes.measure("/busy");
  await fake.reached(1);
  const results = [sizes.measureIfStale("/stale"), sizes.measureIfStale("/new")];
  await Bun.sleep(0);
  fake.gates.get("/busy")!();
  await fake.reached(2);
  fake.gates.get("/new")!();
  await fake.reached(3);
  fake.gates.get("/stale")!();
  await Promise.all([busy, ...results]);
  expect(fake.started).toEqual(["/busy", "/new", "/stale"]);
  await sizes.close();
});

test("overlapping stale checks for one path share a single du run", async () => {
  const fake = gatedRunner();
  const sizes = createSizeService(await cachePath(), fake.runner, 1, clock().now);
  await sizes.load();
  const first = sizes.measureIfStale("/p");
  await fake.reached(1);
  const second = sizes.measureIfStale("/p");
  fake.gates.get("/p")!();
  expect(await second).toBe(await first);
  expect(fake.started).toEqual(["/p"]);
  await sizes.close();
});

test("measure starts its own du even while a stale check for the path is running", async () => {
  const fake = gatedRunner();
  const sizes = createSizeService(await cachePath(), fake.runner, 2, clock().now);
  await sizes.load();
  const stale = sizes.measureIfStale("/p");
  await fake.reached(1);
  const releaseStale = fake.gates.get("/p")!;
  const forced = sizes.measure("/p");
  await fake.reached(2);
  releaseStale();
  fake.gates.get("/p")!();
  expect((await Promise.all([stale, forced])).map((entry) => entry?.sizeKiB)).toEqual([20, 20]);
  expect(fake.started).toEqual(["/p", "/p"]);
  await sizes.close();
});
