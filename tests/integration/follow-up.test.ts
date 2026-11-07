import { afterAll, beforeAll, expect, test, setDefaultTimeout } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDashboardService, type RowPatch } from "../../src/core/scan/dashboard";
import type { WorktreeRow } from "../../src/core/types";
import { createSandbox, findRow, type Sandbox, TEST_TIMEOUT } from "../support/fixture";
import { row, scan, waitFor } from "./helpers";

setDefaultTimeout(TEST_TIMEOUT);

let sandbox: Sandbox;

beforeAll(async () => {
  sandbox = await createSandbox();
});

afterAll(() => sandbox?.cleanup());

test("a follow-up sees every row of a real listing, and its patch holds only while HEAD stays put", async () => {
  const repo = await sandbox.repo("checks");
  const ahead = await repo.unmergedWorktree("ahead");
  const leftover = await repo.unmergedBranch("leftover");
  const { sizes } = await sandbox.services();
  const seen: WorktreeRow[][] = [];
  let answer: (rows: WorktreeRow[]) => RowPatch[] = (rows) => {
    const target = findRow(rows, ahead)!;
    return [
      {
        id: target.id,
        headSha: target.headSha!,
        facts: { mainState: "integrated", integrationReason: "trees_match" },
      },
    ];
  };
  const dashboard = createDashboardService({
    projectRoot: sandbox.scanRoot,
    wtPath: sandbox.wtPath,
    runner: sandbox.runner,
    sizeService: sizes,
    readCreated: sandbox.readCreated,
    followUp: async (listed, rows) => {
      if (listed === repo.path) seen.push(rows);
      return answer(rows);
    },
  });
  try {
    await scan(dashboard, repo);
    expect(seen).toHaveLength(1);
    expect(findRow(seen[0]!, ahead)?.verdict).toBe("Review");
    expect(findRow(seen[0]!, leftover)?.headSha).toBe(await repo.git("rev-parse", "leftover"));
    const checked = await waitFor(dashboard, (snapshot) => snapshot.checking === 0);
    expect(row(checked, ahead)).toMatchObject({ mainState: "integrated", verdict: "Safe" });

    answer = () => [];
    await scan(dashboard, repo);
    const kept = await waitFor(dashboard, (snapshot) => snapshot.checking === 0);
    expect(row(kept, ahead).verdict).toBe("Safe");

    await writeFile(join(ahead.path!, "more.txt"), "more\n");
    await sandbox.git(ahead.path!, "add", "more.txt");
    await sandbox.git(ahead.path!, "commit", "-q", "-m", "More");
    await scan(dashboard, repo);
    const moved = await waitFor(dashboard, (snapshot) => snapshot.checking === 0);
    expect(row(moved, ahead)).toMatchObject({
      headSha: await sandbox.git(ahead.path!, "rev-parse", "HEAD"),
      mainState: "ahead",
      verdict: "Review",
    });
  } finally {
    await dashboard.close();
  }
});
