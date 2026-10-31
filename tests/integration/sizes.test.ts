import { afterAll, afterEach, beforeAll, expect, spyOn, test, setDefaultTimeout } from "bun:test";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createSandbox,
  type Built,
  type Repo,
  type Sandbox,
  TEST_TIMEOUT,
} from "../support/fixture";
import { named, on, record, type Recorder } from "../support/runners";
import { row, waitFor } from "./helpers";

setDefaultTimeout(TEST_TIMEOUT);

let sandbox: Sandbox;
let late: { repo: Repo; built: Built };
let rescanned: { repo: Repo; built: Built };
let joined: { repo: Repo; built: Built };
let planned: { repo: Repo; built: Built };

beforeAll(async () => {
  sandbox = await createSandbox();
  const sized = async (name: string) => {
    const repo = await sandbox.repo(name);
    return { repo, built: await repo.sizedWorktree("sized", { kib: 512 }) };
  };
  [late, rescanned, joined, planned] = await Promise.all(
    ["late", "rescanned", "joined", "planned"].map(sized),
  );
}, 30_000);

afterAll(() => sandbox?.cleanup());

const recorders: Recorder[] = [];
/** A recorder on the sandbox runner whose gates are all released after the test, pass or fail. */
function recording(): Recorder {
  const recorder = record(sandbox.runner);
  recorders.push(recorder);
  return recorder;
}
afterEach(() => {
  for (const recorder of recorders.splice(0)) recorder.releaseAll();
});

test("keeps a size measured while the full listing enriches its rows (#20)", async () => {
  const { repo, built } = late;
  const path = built.path!;
  const recorder = recording();
  const du = recorder.gate(on(named("du"), path));
  const full = recorder.gate(on(named("wt", "--branches"), repo.path));
  const { dashboard, sizes } = await sandbox.services({ runner: recorder.runner });
  const done = dashboard.refresh();
  await du.reached;
  await full.reached;
  const marks = recorder.gate(on(named("git", "config"), repo.path));
  full.release();
  await marks.reached;
  du.release();
  await waitFor(dashboard, (snapshot) => row(snapshot, built).sizeKiB !== null);
  marks.release();
  await done;
  const shown = row(dashboard.getSnapshot(), built);
  expect(dashboard.getSnapshot().progress.phase).toBe("complete");
  expect(sizes.get(path)!.sizeKiB).toBeGreaterThanOrEqual(built.minSizeKiB!);
  expect({ sizeKiB: shown.sizeKiB, measuredAt: shown.sizeMeasuredAt }).toEqual({
    sizeKiB: sizes.get(path)!.sizeKiB,
    measuredAt: sizes.get(path)!.measuredAt,
  });
});

test("a rescan skips du when nothing changed and shows the new size after a top-level change (#3)", async () => {
  const { built } = rescanned;
  const path = built.path!;
  const recorder = recording();
  const { dashboard, sizes } = await sandbox.services({ runner: recorder.runner });
  const du = on(named("du"), path);
  await dashboard.refresh();
  await sizes.measureIfStale(path);
  const before = sizes.get(path)!;

  const counted = recorder.count(du);
  await dashboard.refresh();
  await sizes.measureIfStale(path);
  expect(recorder.count(du) - counted).toBe(0);
  expect(row(dashboard.getSnapshot(), built).sizeKiB).toBe(before.sizeKiB);

  await writeFile(join(path, "big.bin"), randomBytes(2048 * 1024));
  await dashboard.refresh();
  await sizes.measureIfStale(path);
  expect(recorder.count(du) - counted).toBe(1);
  const after = sizes.get(path)!;
  expect(after.sizeKiB).toBeGreaterThanOrEqual(before.sizeKiB + 2048);
  const shown = row(dashboard.getSnapshot(), built);
  expect({ sizeKiB: shown.sizeKiB, measuredAt: shown.sizeMeasuredAt }).toEqual({
    sizeKiB: after.sizeKiB,
    measuredAt: after.measuredAt,
  });
});

test("a rescan joins the size check still running for a worktree (#3)", async () => {
  const { repo, built } = joined;
  const path = built.path!;
  const recorder = recording();
  const du = recorder.gate(on(named("du"), path));
  const { dashboard, sizes } = await sandbox.services({ runner: recorder.runner });
  await writeFile(join(path, "new.bin"), randomBytes(64 * 1024));
  await dashboard.refresh();
  await du.reached;
  const full = recorder.gate(on(named("wt", "--branches"), repo.path));
  const done = dashboard.refresh();
  await full.reached;
  du.release();
  full.release();
  await done;
  await sizes.measureIfStale(path);
  expect(recorder.count(on(named("du"), path))).toBe(1);
  expect(row(dashboard.getSnapshot(), built).sizeKiB).toBe(sizes.get(path)!.sizeKiB);
});

test("keeps measured sizes in the removal plan (#21)", async () => {
  const { repo, built } = planned;
  const path = built.path!;
  const { dashboard, actions, sizes } = await sandbox.services();
  await dashboard.refresh([repo.path]);
  await sizes.measureIfStale(path);
  const shown = row(dashboard.getSnapshot(), built);
  const measured = sizes.get(path)!;
  expect(measured.sizeKiB).toBeGreaterThanOrEqual(built.minSizeKiB!);
  expect({ sizeKiB: shown.sizeKiB, measuredAt: shown.sizeMeasuredAt }).toEqual({
    sizeKiB: measured.sizeKiB,
    measuredAt: measured.measuredAt,
  });
  const [entry] = (await actions.prepareRemoval([shown])).entries;
  expect(entry!.blockedReason).toBeNull();
  expect({ sizeKiB: entry!.row.sizeKiB, measuredAt: entry!.row.sizeMeasuredAt }).toEqual({
    sizeKiB: measured.sizeKiB,
    measuredAt: measured.measuredAt,
  });
});

test("audit #5: scan, manual remeasure, rescan and restart keep the newest real du result", async () => {
  const repo = await sandbox.repo("overlapping-sizes");
  const built = await repo.sizedWorktree("sized", { kib: 512 });
  const path = built.path!;
  const matches = on(named("du"), path);
  let first = true;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const measured = new Promise<void>((resolve) => (reached = resolve));
  const app = await sandbox.services({
    runner: async (command, args, signal, environment) => {
      const hold = first && matches({ command, args });
      if (hold) first = false;
      const result = await sandbox.runner(command, args, signal, environment);
      if (hold) {
        reached();
        await blocked;
      }
      return result;
    },
  });
  try {
    await app.dashboard.refresh([repo.path]);
    await measured;
    const shown = row(app.dashboard.getSnapshot(), built);
    await writeFile(join(path, "more.bin"), randomBytes(2048 * 1024));
    await app.dashboard.refreshSize(shown.id);
    const newest = app.sizes.get(path)!;
    expect(newest.sizeKiB).toBeGreaterThanOrEqual(2560);
    release();
    await waitFor(app.dashboard, (snapshot) => !snapshot.sizing.includes(path));
    expect(app.sizes.get(path)).toEqual(newest);
    await app.dashboard.refresh([repo.path]);
    await app.sizes.measureIfStale(path);
    expect(row(app.dashboard.getSnapshot(), built).sizeKiB).toBe(newest.sizeKiB);
    await app.close();
    expect(JSON.parse(await readFile(join(sandbox.cacheDir, "sizes.json"), "utf8"))[path]).toEqual(
      newest,
    );
    const restarted = await sandbox.services();
    try {
      await restarted.dashboard.refresh([repo.path]);
      expect(row(restarted.dashboard.getSnapshot(), built).sizeKiB).toBe(newest.sizeKiB);
    } finally {
      await restarted.close();
    }
  } finally {
    release();
    await app.close();
  }
});

test.each([true, false])(
  "audit #5/#7: a rescan joining a persisting older result keeps the manual size (older finishes first=%s)",
  async (olderFirst) => {
    const repo = await sandbox.repo(`rejoined-sizes-${olderFirst}`);
    const built = await repo.sizedWorktree("sized", { kib: 512 });
    const path = built.path!;
    const matches = on(named("du"), path);
    const releases: Array<() => void> = [];
    const starts: Array<() => void> = [];
    const gates = [0, 1].map((i) => new Promise<void>((resolve) => (releases[i] = resolve)));
    const reached = [0, 1].map((i) => new Promise<void>((resolve) => (starts[i] = resolve)));
    const rename = fs.rename;
    let heldWrite = false;
    const spy = spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (
        !heldWrite &&
        args[1] === join(sandbox.cacheDir, "sizes.json") &&
        JSON.parse(await readFile(args[0], "utf8"))[path]
      ) {
        heldWrite = true;
        starts[0]!();
        await gates[0];
      }
      return rename(...args);
    });
    let number = 0;
    const app = await sandbox.services({
      runner: async (command, args, signal, environment) => {
        const index = matches({ command, args }) ? number++ : -1;
        const result = await sandbox.runner(command, args, signal, environment);
        if (index === 1) {
          starts[1]!();
          await gates[1];
        }
        return result;
      },
    });
    try {
      await app.dashboard.refresh([repo.path]);
      await reached[0];
      const shown = row(app.dashboard.getSnapshot(), built);
      await writeFile(join(path, "more.bin"), randomBytes(2048 * 1024));
      const forced = app.dashboard.refreshSize(shown.id);
      await reached[1];
      await app.dashboard.refresh([repo.path]);
      if (olderFirst) {
        releases[0]!();
        await app.sizes.measureIfStale(path);
        releases[1]!();
      } else {
        releases[1]!();
        const deadline = Date.now() + 1000;
        while (app.sizes.get(path)!.sizeKiB < 2560) {
          if (Date.now() > deadline)
            throw new Error("manual size was not accepted while the write was blocked");
          await Bun.sleep(1);
        }
        releases[0]!();
      }
      await forced;
      await waitFor(app.dashboard, (snapshot) => !snapshot.sizing.includes(path));
      expect(app.sizes.get(path)!.sizeKiB).toBeGreaterThanOrEqual(2560);
      expect(row(app.dashboard.getSnapshot(), built).sizeKiB).toBe(app.sizes.get(path)!.sizeKiB);
    } finally {
      for (const release of releases) release();
      await app.close();
      spy.mockRestore();
    }
  },
);

test("audit #7: a real fresh-cache rescan avoids one publication per worktree", async () => {
  const repo = await sandbox.repo("fresh-many");
  for (let i = 0; i < 20; i++) await repo.sizedWorktree(`sized-${i}`, { kib: 8 });
  const recorder = recording();
  const app = await sandbox.services({ runner: recorder.runner });
  try {
    await app.dashboard.refresh([repo.path]);
    await waitFor(app.dashboard, (snapshot) => snapshot.sizing.length === 0);
    const du = recorder.count(named("du"));
    let publications = 0;
    const unsubscribe = app.dashboard.subscribe(() => publications++);
    try {
      await app.dashboard.refresh([repo.path]);
      await waitFor(app.dashboard, (snapshot) => snapshot.sizing.length === 0);
      expect(app.dashboard.getSnapshot().rows).toHaveLength(20);
      expect(app.dashboard.getSnapshot().rows.every((row) => row.sizeKiB !== null)).toBe(true);
      expect(recorder.count(named("du"))).toBe(du);
      expect(publications).toBeLessThan(20);
    } finally {
      unsubscribe();
    }
  } finally {
    await app.close();
  }
});
