import { expect, test } from "bun:test";
import fixture from "../fixtures/list-v2.json";
import { createDashboardService, type RowPatch } from "../../src/core/scan/dashboard";
import type {
  CommandRunner,
  DashboardService,
  DashboardSnapshot,
  SizeService,
  WorktreeRow,
} from "../../src/core/types";

const sizeService: SizeService = {
  load: async () => {},
  get: () => null,
  measure: async () => null,
  measureIfStale: async () => null,
  close: async () => {},
};

/** The fixture's listing, with the detached worktree's HEAD at `sha`. */
function listing(sha = "ccc"): string {
  return JSON.stringify({
    ...fixture,
    items: fixture.items.map((item) =>
      item.branch === null ? { ...item, head: { ...item.head, sha } } : item,
    ),
  });
}

function runner(stdout: () => string = () => listing()): CommandRunner {
  return async () => ({ stdout: stdout(), stderr: "", exitCode: 0 });
}

const detached = (rows: WorktreeRow[]) => rows.find((row) => row.branch === null)!;

/** Proves the detached worktree merged, which only a follow-up can say about the fixture. */
function merged(rows: WorktreeRow[], subject = "checked"): RowPatch[] {
  const row = detached(rows);
  return [
    {
      id: row.id,
      headSha: row.headSha!,
      facts: { mainState: "integrated", integrationReason: "trees_match", subject },
    },
  ];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function waitFor(
  service: DashboardService,
  predicate: (snapshot: DashboardSnapshot) => boolean,
): Promise<DashboardSnapshot> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("snapshot timeout"));
    }, 1000);
    unsubscribe = service.subscribe((snapshot) => {
      if (!predicate(snapshot)) return;
      clearTimeout(timer);
      queueMicrotask(unsubscribe);
      resolve(snapshot);
    });
  });
}

test("a follow-up's result arrives after the listing, patches its row and is published", async () => {
  const held = deferred<RowPatch[]>();
  const calls: Array<{ repo: string; rows: WorktreeRow[] }> = [];
  const service = createDashboardService({
    projectRoot: "/projects",
    wtPath: "/wt",
    runner: runner(),
    sizeService,
    discover: async () => ["/repo"],
    followUp: (repo, rows) => {
      calls.push({ repo, rows });
      return held.promise;
    },
  });
  try {
    await service.refresh();
    const listed = service.getSnapshot();
    expect(listed.progress.phase).toBe("complete");
    expect(listed.checking).toBe(1);
    expect(detached(listed.rows).verdict).toBe("Review");
    expect(calls.map((call) => call.repo)).toEqual(["/repo"]);
    expect(calls[0]!.rows).toEqual(listed.rows);

    held.resolve(merged(listed.rows));
    const patched = await waitFor(service, (snapshot) => snapshot.checking === 0);
    expect(detached(patched.rows)).toMatchObject({
      subject: "checked",
      mainState: "integrated",
      verdict: "Safe",
    });
    expect(patched.rows.filter((row) => row.branch !== null)).toEqual(
      listed.rows.filter((row) => row.branch !== null),
    );
  } finally {
    await service.close();
  }
});

test("checking counts each repo's follow-up while it runs and returns to 0", async () => {
  const held = new Map<string, ReturnType<typeof deferred<RowPatch[]>>>();
  const service = createDashboardService({
    projectRoot: "/projects",
    wtPath: "/wt",
    runner: runner(),
    sizeService,
    discover: async () => ["/one", "/two"],
    followUp: (repo) => {
      const next = deferred<RowPatch[]>();
      held.set(repo, next);
      return next.promise;
    },
  });
  const counts: number[] = [];
  service.subscribe((snapshot) => counts.push(snapshot.checking));
  try {
    await service.refresh();
    expect(service.getSnapshot().checking).toBe(2);
    held.get("/one")!.resolve([]);
    await waitFor(service, (snapshot) => snapshot.checking === 1);
    held.get("/two")!.resolve([]);
    await waitFor(service, (snapshot) => snapshot.checking === 0);
    expect(counts).toContain(2);
    expect(counts.at(-1)).toBe(0);
  } finally {
    await service.close();
  }
});

test("a patch lasts through later listings and rescans until a follow-up replaces it", async () => {
  let answer: (rows: WorktreeRow[]) => Promise<RowPatch[]> = async (rows) => merged(rows);
  const service = createDashboardService({
    projectRoot: "/projects",
    wtPath: "/wt",
    runner: runner(),
    sizeService,
    discover: async () => ["/repo"],
    // Linked worktrees, so each scan lists them alone before the full listing.
    readLinked: async () => ({ count: 2, paths: [], unread: [] }),
    followUp: (_repo, rows) => answer(rows),
  });
  try {
    await service.refresh();
    await waitFor(service, (snapshot) => detached(snapshot.rows).subject === "checked");

    const held = deferred<RowPatch[]>();
    answer = () => held.promise;
    const seen: DashboardSnapshot[] = [];
    const unsubscribe = service.subscribe((snapshot) => seen.push(snapshot));
    await service.refresh();
    unsubscribe();
    const listings = seen.filter((snapshot) => snapshot.rows.length > 0);
    expect(listings.length).toBeGreaterThan(1);
    for (const snapshot of listings)
      expect(detached(snapshot.rows)).toMatchObject({ subject: "checked", verdict: "Safe" });
    held.resolve([]);
    await waitFor(service, (snapshot) => snapshot.checking === 0);
    expect(detached(service.getSnapshot().rows).subject).toBe("checked");

    answer = async (rows) => merged(rows, "checked again");
    await service.refresh();
    await waitFor(service, (snapshot) => detached(snapshot.rows).subject === "checked again");
  } finally {
    await service.close();
  }
});

test("a patch does not apply once the row's HEAD has moved", async () => {
  let sha = "ccc";
  let answer: (rows: WorktreeRow[]) => RowPatch[] = merged;
  const service = createDashboardService({
    projectRoot: "/projects",
    wtPath: "/wt",
    runner: runner(() => listing(sha)),
    sizeService,
    discover: async () => ["/repo"],
    followUp: async (_repo, rows) => answer(rows),
  });
  try {
    await service.refresh();
    await waitFor(service, (snapshot) => detached(snapshot.rows).subject === "checked");

    sha = "ddd";
    answer = () => [];
    await service.refresh();
    await waitFor(service, (snapshot) => snapshot.checking === 0);
    expect(detached(service.getSnapshot().rows)).toMatchObject({
      headSha: "ddd",
      subject: "detached",
      mainState: "ahead",
      verdict: "Review",
    });
  } finally {
    await service.close();
  }
});

test("a rescan aborts the follow-ups still running", async () => {
  const signals: AbortSignal[] = [];
  const service = createDashboardService({
    projectRoot: "/projects",
    wtPath: "/wt",
    runner: runner(),
    sizeService,
    discover: async () => ["/repo"],
    followUp: (_repo, _rows, signal) => {
      signals.push(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    },
  });
  try {
    await service.refresh();
    expect(signals[0]!.aborted).toBe(false);
    const rescan = service.refresh();
    expect(signals[0]!.aborted).toBe(true);
    await rescan;
    expect(signals).toHaveLength(2);
    expect(signals[1]!.aborted).toBe(false);
    expect(service.getSnapshot().checking).toBe(1);
  } finally {
    await service.close();
  }
});

test("a result from a scan that a rescan replaced is dropped", async () => {
  const held: Array<ReturnType<typeof deferred<RowPatch[]>>> = [];
  const service = createDashboardService({
    projectRoot: "/projects",
    wtPath: "/wt",
    runner: runner(),
    sizeService,
    discover: async () => ["/repo"],
    // Ignores the abort, as a request that already answered would.
    followUp: () => {
      held.push(deferred<RowPatch[]>());
      return held.at(-1)!.promise;
    },
  });
  try {
    await service.refresh();
    const rows = service.getSnapshot().rows;
    await service.refresh();
    held[0]!.resolve(merged(rows));
    await waitFor(service, (snapshot) => snapshot.checking === 1);
    expect(detached(service.getSnapshot().rows).subject).toBe("detached");
    held[1]!.resolve([]);
    await waitFor(service, (snapshot) => snapshot.checking === 0);
    expect(detached(service.getSnapshot().rows).subject).toBe("detached");
  } finally {
    await service.close();
  }
});

test("close aborts the follow-ups still running", async () => {
  let signal!: AbortSignal;
  const service = createDashboardService({
    projectRoot: "/projects",
    wtPath: "/wt",
    runner: runner(),
    sizeService,
    discover: async () => ["/repo"],
    followUp: (_repo, _rows, given) => {
      signal = given;
      return new Promise(() => {});
    },
  });
  await service.refresh();
  expect(signal.aborted).toBe(false);
  await service.close();
  expect(signal.aborted).toBe(true);
});

test("a follow-up that rejects leaves the rows as listed and the scan intact", async () => {
  const plain = createDashboardService({
    projectRoot: "/projects",
    wtPath: "/wt",
    runner: runner(),
    sizeService,
    discover: async () => ["/repo"],
  });
  const failing = createDashboardService({
    projectRoot: "/projects",
    wtPath: "/wt",
    runner: runner(),
    sizeService,
    discover: async () => ["/repo"],
    followUp: async () => {
      throw new Error("offline");
    },
  });
  try {
    await plain.refresh();
    await failing.refresh();
    const snapshot = await waitFor(failing, (next) => next.checking === 0);
    expect(snapshot.progress.phase).toBe("complete");
    expect(snapshot.errors).toEqual({});
    expect(snapshot.fatalError).toBeNull();
    expect(snapshot.rows).toEqual(plain.getSnapshot().rows);
  } finally {
    await plain.close();
    await failing.close();
  }
});

test("without a follow-up, every snapshot counts 0 checking", async () => {
  const service = createDashboardService({
    projectRoot: "/projects",
    wtPath: "/wt",
    runner: runner(),
    sizeService,
    discover: async () => ["/repo"],
  });
  const counts: number[] = [];
  service.subscribe((snapshot) => counts.push(snapshot.checking));
  try {
    await service.refresh();
    expect(counts.length).toBeGreaterThan(1);
    expect(new Set(counts)).toEqual(new Set([0]));
  } finally {
    await service.close();
  }
});
