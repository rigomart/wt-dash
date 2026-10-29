import { afterAll, afterEach, beforeAll, expect, test, setDefaultTimeout } from "bun:test";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
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

// Fails until the full listing reads sizes after enriching its rows.
test.failing("keeps a size measured while the full listing enriches its rows (#20)", async () => {
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
