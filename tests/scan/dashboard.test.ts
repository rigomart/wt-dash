import { expect, test } from "bun:test";
import fixture from "../fixtures/list-v2.json";
import { createDashboardService } from "../../src/core/scan/dashboard";
import type {
  CommandRunner,
  DashboardService,
  DashboardSnapshot,
  SizeEntry,
  SizeService,
} from "../../src/core/types";

const data = JSON.stringify(fixture);
const sizeService: SizeService = {
  load: async () => {},
  get: () => null,
  measure: async () => null,
  measureIfStale: async () => null,
  close: async () => {},
};

function result(stdout = data, exitCode = 0) {
  return { stdout, stderr: exitCode ? "failed" : "", exitCode };
}

test("requests schema 2 even when Worktrunk's default is schema 1", async () => {
  const runner: CommandRunner = async (_command, args) => {
    if (!args.includes("list")) return result("");
    return result(args.includes("list.json-schema=2") ? data : "[]");
  };
  const service = createDashboardService({
    projectRoot: "/projects",
    wtPath: "/wt",
    runner,
    sizeService,
    discover: async () => ["/repo"],
  });
  try {
    await service.refresh();
    expect(service.getSnapshot().fatalError).toBeNull();
    expect(service.getSnapshot().rows).toHaveLength(2);
  } finally {
    await service.close();
  }
});

function waitFor(
  service: DashboardService,
  predicate: (value: DashboardSnapshot) => boolean,
): Promise<DashboardSnapshot> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("snapshot timeout"));
    }, 1000);
    const unsubscribe = service.subscribe((snapshot) => {
      if (predicate(snapshot)) {
        clearTimeout(timer);
        queueMicrotask(unsubscribe);
        resolve(snapshot);
      }
    });
  });
}

test("publishes a fast repo before a slow repo completes and keeps detached rows", async () => {
  let releaseSlow!: () => void;
  const slow = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  const runner: CommandRunner = async (_command, args) => {
    if (args[1] === "/slow") await slow;
    return result();
  };
  const service = createDashboardService({
    projectRoot: "/projects",
    wtPath: "/opt/homebrew/bin/wt",
    runner,
    sizeService,
    discover: async () => ["/fast", "/slow"],
  });
  const seen: DashboardSnapshot[] = [];
  service.subscribe((snapshot) => seen.push(snapshot));
  const pending = service.refresh();
  const early = await waitFor(service, (snapshot) => snapshot.rows.length === 2);
  expect(early.progress.phase).toBe("scanning");
  expect(early.rows.some((row) => row.branch === null)).toBe(true);
  expect(seen[0]?.progress.phase).toBe("idle");
  releaseSlow();
  await pending;
  expect(service.getSnapshot().rows).toHaveLength(4);
  await service.close();
});

test("runs at most four Worktrunk scans concurrently", async () => {
  let active = 0;
  let peak = 0;
  const service = createDashboardService({
    projectRoot: "/projects",
    wtPath: "/opt/homebrew/bin/wt",
    sizeService,
    discover: async () => Array.from({ length: 7 }, (_, i) => `/repo-${i}`),
    runner: async (_command, args) => {
      if (!args.includes("list")) return result("", 1);
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(10);
      active--;
      return result();
    },
  });
  await service.refresh();
  expect(peak).toBe(4);
  expect(service.getSnapshot().progress.reposDone).toBe(7);
  await service.close();
});

test("a rescan keeps the current rows on screen until each repo's fresh listing replaces them", async () => {
  let release!: () => void;
  let hold = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = createDashboardService({
    projectRoot: "/projects",
    wtPath: "/opt/homebrew/bin/wt",
    sizeService,
    discover: async () => ["/one", "/two"],
    runner: async (_command, args) => {
      if (hold && args[1] === "/two") await gate;
      return result();
    },
  });
  await service.refresh();
  expect(service.getSnapshot().rows).toHaveLength(4);
  hold = true;
  const pending = service.refresh();
  const midway = await waitFor(
    service,
    (snapshot) => snapshot.progress.phase === "scanning" && snapshot.progress.reposDone === 1,
  );
  expect(midway.rows).toHaveLength(4);
  release();
  await pending;
  expect(service.getSnapshot().rows).toHaveLength(4);
  await service.close();
});

test("a targeted rescan lists only the given repos and leaves the others alone", async () => {
  const listed: string[] = [];
  let discovered = 0;
  const service = createDashboardService({
    projectRoot: "/projects",
    wtPath: "/opt/homebrew/bin/wt",
    sizeService,
    discover: async () => {
      discovered++;
      return ["/one", "/two"];
    },
    runner: async (_command, args) => {
      if (args.includes("list")) listed.push(args[1]!);
      return result();
    },
  });
  await service.refresh();
  listed.length = 0;
  await service.refresh(["/two"]);
  expect(discovered).toBe(1);
  expect(listed).toEqual(["/two"]);
  expect(
    service
      .getSnapshot()
      .rows.map((row) => row.repoPath)
      .sort(),
  ).toEqual(["/one", "/one", "/two", "/two"]);
  await service.close();
});

test("a full rescan drops rows from repos that are no longer discovered", async () => {
  let repos = ["/one", "/two"];
  const service = createDashboardService({
    projectRoot: "/projects",
    wtPath: "/opt/homebrew/bin/wt",
    sizeService,
    discover: async () => repos,
    runner: async () => result(),
  });
  await service.refresh();
  repos = ["/one"];
  await service.refresh();
  expect(service.getSnapshot().rows.every((row) => row.repoPath === "/one")).toBe(true);
  await service.close();
});

test("shows repo errors while keeping successful rows", async () => {
  const service = createDashboardService({
    projectRoot: "/projects",
    wtPath: "/opt/homebrew/bin/wt",
    sizeService,
    discover: async () => ["/bad", "/good"],
    runner: async (_command, args) => (args[1] === "/bad" ? result("", 1) : result()),
  });
  await service.refresh();
  expect(service.getSnapshot().rows).toHaveLength(2);
  expect(service.getSnapshot().errors["/bad"]).toContain("failed");
  expect(service.getSnapshot().progress.phase).toBe("complete");
  await service.close();
});

test("unsupported schema clears partial rows and stops with a fatal error", async () => {
  let releaseBad!: () => void;
  const bad = new Promise<void>((resolve) => {
    releaseBad = resolve;
  });
  const service = createDashboardService({
    projectRoot: "/projects",
    wtPath: "/opt/homebrew/bin/wt",
    sizeService,
    discover: async () => ["/good", "/bad"],
    runner: async (_command, args) => {
      if (args[1] === "/bad") {
        await bad;
        return result(JSON.stringify({ ...fixture, schema: 1 }));
      }
      return result();
    },
  });
  const pending = service.refresh();
  await waitFor(service, (snapshot) => snapshot.rows.length > 0);
  releaseBad();
  await pending;
  expect(service.getSnapshot().fatalError).toContain("schema");
  expect(service.getSnapshot().rows).toEqual([]);
  expect(service.getSnapshot().progress.phase).toBe("error");
  await service.close();
});

test("malformed Worktrunk JSON stops the scan instead of leaving Safe rows", async () => {
  const service = createDashboardService({
    projectRoot: "/projects",
    wtPath: "/opt/homebrew/bin/wt",
    sizeService,
    discover: async () => ["/good", "/bad"],
    runner: async (_command, args) => (args[1] === "/bad" ? result("{") : result()),
  });
  await service.refresh();
  expect(service.getSnapshot().fatalError).toContain("JSON");
  expect(service.getSnapshot().rows).toEqual([]);
  expect(service.getSnapshot().progress.phase).toBe("error");
  await service.close();
});

test("an old refresh cannot overwrite a newer snapshot", async () => {
  let releaseOld!: () => void;
  const old = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  let calls = 0;
  const newer = JSON.parse(data);
  newer.items[1].branch = "newer";
  const service = createDashboardService({
    projectRoot: "/projects",
    wtPath: "/opt/homebrew/bin/wt",
    sizeService,
    discover: async () => ["/repo"],
    readLinked: async () => ({ count: 2, paths: [] }),
    runner: async () => {
      calls++;
      if (calls === 1) {
        await old;
        return result();
      }
      return result(JSON.stringify(newer));
    },
  });
  const first = service.refresh();
  await Bun.sleep(0);
  await service.refresh();
  releaseOld();
  await first;
  expect(service.getSnapshot().generation).toBe(2);
  expect(service.getSnapshot().rows[0]?.branch).toBe("newer");
  await service.close();
});

test("cached size is included before a fresh measurement finishes", async () => {
  const cached: SizeService = {
    ...sizeService,
    get: (path) =>
      path.includes("a space") ? { sizeKiB: 123, measuredAt: "2026-09-28T00:00:00Z" } : null,
  };
  const service = createDashboardService({
    projectRoot: "/projects",
    wtPath: "/opt/homebrew/bin/wt",
    sizeService: cached,
    discover: async () => ["/repo"],
    runner: async () => result(),
  });
  await service.refresh();
  expect(service.getSnapshot().rows.find((row) => row.branch === "feature/name")?.sizeKiB).toBe(
    123,
  );
  await service.close();
});

test("scans read when agent marks were set from Worktrunk's state, never from processes", async () => {
  const marked = structuredClone(fixture);
  Object.assign(marked.items[1]!, { marker: "🤖" });
  const setAt = (repo: string) =>
    Math.floor((Date.now() - (repo === "/one" ? 3_600_000 : 30 * 86_400_000)) / 1000);
  const calls: string[][] = [];
  const service = createDashboardService({
    projectRoot: "/projects",
    wtPath: "/wt",
    sizeService,
    discover: async () => ["/one", "/two"],
    readCreated: async () => "2026-09-01T00:00:00Z",
    runner: async (command, args) => {
      calls.push([command, ...args]);
      if (args.includes("list")) return result(JSON.stringify(marked));
      if (args.includes("--get-regexp"))
        return result(
          `worktrunk.state.feature/name.marker\n{"marker":"🤖","set_at":${setAt(args[1]!)}}\0`,
        );
      return result("", 1);
    },
  });
  try {
    await service.refresh();
    expect(
      service
        .getSnapshot()
        .rows.filter((row) => row.branch === "feature/name")
        .map((row) => [row.repoPath, row.verdict, row.reason])
        .sort(),
    ).toEqual([
      ["/one", "Review", "An agent was working here 1h ago."],
      ["/two", "Safe", "Its changes are in main (squash or rebase merge)."],
    ]);
    expect(calls.filter((call) => call.includes("--get-regexp"))).toHaveLength(2);
    expect(calls.some((call) => call[0] === "lsof" || call[0] === "ps")).toBe(false);
    expect(service.getSnapshot().progress.phase).toBe("complete");
  } finally {
    await service.close();
  }
});

test("branches without a worktree are listed and aged like `wt step prune`, but never measured", async () => {
  const payload: any = structuredClone(fixture);
  for (const branch of ["old", "young"])
    payload.items.push({
      branch,
      head: { sha: branch },
      default_branch: { ahead: 0, behind: 1, integration: { reason: "ancestor" } },
      display: { state: "integrated" },
    });
  const measured: string[] = [];
  const calls: string[][] = [];
  const service = createDashboardService({
    projectRoot: "/projects",
    wtPath: "/wt",
    sizeService: {
      ...sizeService,
      measure: async (path) => {
        measured.push(path);
        return null;
      },
      measureIfStale: async (path) => {
        measured.push(path);
        return null;
      },
    },
    discover: async () => ["/repo"],
    readBranchCreated: async (_repo, branch) =>
      new Date(Date.now() - (branch === "old" ? 3 : 0.1) * 86_400_000).toISOString(),
    runner: async (command, args) => {
      calls.push([command, ...args]);
      return args.includes("list") ? result(JSON.stringify(payload)) : result("", 1);
    },
  });
  try {
    await service.refresh();
    const rows = service.getSnapshot().rows.filter((row) => row.kind === "branch");
    expect(rows.map((row) => [row.branch, row.path, row.verdict, row.reason])).toEqual([
      ["old", null, "Safe", "Its commits are already in main."],
      ["young", null, "Review", "Created 2h ago, so it may still be in use."],
    ]);
    expect(calls.find((call) => call.includes("list"))).toContain("--branches");
    expect(measured).toHaveLength(2);
    await service.refreshSize(rows[0]!.id);
    expect(measured).toHaveLength(2);
  } finally {
    await service.close();
  }
});

test("lists worktrees before branches without a worktree, and measures each worktree once", async () => {
  const payload: any = structuredClone(fixture);
  payload.items.push({
    branch: "leftover",
    head: { sha: "leftover" },
    default_branch: { ahead: 0, behind: 1, integration: { reason: "ancestor" } },
    display: { state: "integrated" },
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lists: string[][] = [];
  const measured: string[] = [];
  const service = createDashboardService({
    projectRoot: "/projects",
    wtPath: "/wt",
    sizeService: {
      ...sizeService,
      measureIfStale: async (path) => {
        measured.push(path);
        return null;
      },
    },
    discover: async () => ["/repo"],
    readLinked: async () => ({ count: 2, paths: [] }),
    runner: async (_command, args) => {
      if (!args.includes("list")) return result("", 1);
      lists.push(args);
      if (args.includes("--branches")) await gate;
      return result(JSON.stringify(payload));
    },
  });
  try {
    const pending = service.refresh();
    const early = await waitFor(service, (snapshot) => snapshot.rows.length > 0);
    expect(early.progress.phase).toBe("scanning");
    expect(early.rows.map((row) => row.kind)).toEqual(["worktree", "worktree"]);
    expect(lists[0]).not.toContain("--branches");
    release();
    await pending;
    expect(lists.map((args) => args.includes("--branches"))).toEqual([false, true]);
    expect(
      service
        .getSnapshot()
        .rows.map((row) => row.branch ?? "detached")
        .sort(),
    ).toEqual(["detached", "feature/name", "leftover"]);
    expect(measured).toHaveLength(2);
  } finally {
    await service.close();
  }
});

test("lists the first project's worktrees on their own before the other projects'", async () => {
  const events: string[] = [];
  const service = createDashboardService({
    projectRoot: "/projects",
    wtPath: "/wt",
    sizeService,
    discover: async () => ["/big", "/small-1", "/small-2"],
    readLinked: async (repo) => ({ count: repo === "/big" ? 5 : 1, paths: [] }),
    runner: async (_command, args) => {
      if (!args.includes("list") || args.includes("--branches")) return result();
      events.push(`start ${args[1]}`);
      await Bun.sleep(5);
      events.push(`end ${args[1]}`);
      return result();
    },
  });
  try {
    await service.refresh();
    expect(events.slice(0, 2)).toEqual(["start /big", "end /big"]);
    expect(events).toHaveLength(6);
  } finally {
    await service.close();
  }
});

test("a failed worktree listing leaves the repo to its full listing", async () => {
  const measured: string[] = [];
  const service = createDashboardService({
    projectRoot: "/projects",
    wtPath: "/wt",
    sizeService: {
      ...sizeService,
      measureIfStale: async (path) => {
        measured.push(path);
        return null;
      },
    },
    discover: async () => ["/flaky", "/bad"],
    readLinked: async () => ({ count: 2, paths: [] }),
    runner: async (_command, args) => {
      if (!args.includes("list")) return result("", 1);
      if (args[1] === "/bad") return result("", 1);
      return args.includes("--branches") ? result() : result("{");
    },
  });
  try {
    await service.refresh();
    const snapshot = service.getSnapshot();
    expect(snapshot.fatalError).toBeNull();
    expect(snapshot.errors["/bad"]).toContain("failed");
    expect(snapshot.rows.map((row) => row.repoPath)).toEqual(["/flaky", "/flaky"]);
    expect(measured).toHaveLength(2);
    expect(snapshot.progress).toMatchObject({ phase: "complete", reposDone: 2 });
  } finally {
    await service.close();
  }
});

test("Git-safe rows are immediately available while other repositories are still scanning", async () => {
  const { removalBlockReason } = await import("../../src/core/actions");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = createDashboardService({
    projectRoot: "/projects",
    wtPath: "/wt",
    sizeService,
    discover: async () => ["/fast", "/slow"],
    runner: async (_command, args) => {
      if (args[1] === "/slow") await gate;
      return args.includes("list") ? result() : result("", 1);
    },
  });
  const scanning = service.refresh();
  try {
    const early = await waitFor(service, (snapshot) => snapshot.rows.length === 2);
    expect(early.rows[0]!.verdict).toBe("Safe");
    expect(removalBlockReason(early.rows[0]!)).toBeNull();
  } finally {
    release();
    await scanning;
    await service.close();
  }
});

test("a scan measures only stale sizes and publishes only for new measurements", async () => {
  const forced: string[] = [];
  const checked: string[] = [];
  const settle: Array<() => void> = [];
  const saved = new Map<string, SizeEntry>();
  const sizes: SizeService = {
    ...sizeService,
    get: (path) => saved.get(path) ?? null,
    measure: async (path) => {
      forced.push(path);
      return null;
    },
    measureIfStale: (path) => {
      checked.push(path);
      const entry = path.includes("a space")
        ? { sizeKiB: 77, measuredAt: "2026-10-01T00:00:00Z" }
        : null;
      return new Promise((resolve) =>
        settle.push(() => {
          if (entry) saved.set(path, entry);
          resolve(entry);
        }),
      );
    },
  };
  const service = createDashboardService({
    projectRoot: "/projects",
    wtPath: "/wt",
    sizeService: sizes,
    discover: async () => ["/repo"],
    runner: async () => result(),
  });
  let published = 0;
  service.subscribe(() => published++);
  try {
    await service.refresh();
    expect(checked).toHaveLength(2);
    expect(forced).toEqual([]);
    const before = published;
    for (const resolve of settle) resolve();
    await Bun.sleep(0);
    expect(published).toBe(before + 1);
    expect(service.getSnapshot().rows.find((row) => row.branch === "feature/name")?.sizeKiB).toBe(
      77,
    );
  } finally {
    await service.close();
  }
});

test("remeasuring a worktree always measures, even when its saved size is fresh", async () => {
  const forced: string[] = [];
  const sizes: SizeService = {
    ...sizeService,
    measure: async (path) => {
      forced.push(path);
      return { sizeKiB: 9, measuredAt: "2026-10-01T00:00:00Z" };
    },
  };
  const service = createDashboardService({
    projectRoot: "/projects",
    wtPath: "/wt",
    sizeService: sizes,
    discover: async () => ["/repo"],
    runner: async () => result(),
  });
  try {
    await service.refresh();
    expect(forced).toEqual([]);
    const row = service
      .getSnapshot()
      .rows.find((candidate) => candidate.branch === "feature/name")!;
    await service.refreshSize(row.id);
    expect(forced).toEqual([row.path!]);
    expect(service.getSnapshot().rows.find((candidate) => candidate.id === row.id)?.sizeKiB).toBe(
      9,
    );
  } finally {
    await service.close();
  }
});

test("a fresh size saved while a rescan was listing still reaches the screen", async () => {
  let saved: SizeEntry = { sizeKiB: 8, measuredAt: "2026-10-01T00:00:00Z" };
  const sizes: SizeService = { ...sizeService, get: () => saved };
  const service = createDashboardService({
    projectRoot: "/projects",
    wtPath: "/wt",
    sizeService: sizes,
    discover: async () => ["/repo"],
    runner: async (_command, args) => {
      if (args.includes("rev-parse")) saved = { sizeKiB: 20, measuredAt: "2026-10-01T01:00:00Z" };
      return result();
    },
  });
  try {
    await service.refresh();
    await Bun.sleep(0);
    expect(service.getSnapshot().rows.map((row) => row.sizeKiB)).toEqual([20, 20]);
  } finally {
    await service.close();
  }
});

test("publishes discovered repos with their linked worktree counts before listing them", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = createDashboardService({
    projectRoot: "/projects",
    wtPath: "/opt/homebrew/bin/wt",
    sizeService,
    discover: async () => ["/one", "/two"],
    readLinked: async (repo) => ({ count: repo === "/one" ? 3 : 0, paths: [] }),
    runner: async () => {
      await gate;
      return result();
    },
  });
  const pending = service.refresh();
  const early = await waitFor(service, (snapshot) => snapshot.repos.length === 2);
  expect(early.rows).toEqual([]);
  expect(early.repos).toEqual([
    { path: "/one", linked: 3 },
    { path: "/two", linked: 0 },
  ]);
  release();
  await pending;
  await service.close();
});

test("a targeted rescan recounts only its repos", async () => {
  let linked = 1;
  const service = createDashboardService({
    projectRoot: "/projects",
    wtPath: "/opt/homebrew/bin/wt",
    sizeService,
    discover: async () => ["/one", "/two"],
    readLinked: async () => ({ count: linked, paths: [] }),
    runner: async () => result(),
  });
  await service.refresh();
  linked = 0;
  await service.refresh(["/two"]);
  expect(service.getSnapshot().repos).toEqual([
    { path: "/one", linked: 1 },
    { path: "/two", linked: 0 },
  ]);
  await service.close();
});

test("a scan reads each worktree's creation time, so a new worktree with no commits isn't Safe", async () => {
  const payload: any = structuredClone(fixture);
  for (const item of payload.items.slice(1)) {
    item.display = { state: "empty" };
    item.default_branch = { ahead: 0, behind: 0, integration: { reason: "same_commit" } };
  }
  const [, old, young] = payload.items.map((item: any) => item.worktree.path);
  const created: Record<string, string> = {
    [old]: "2026-09-27T00:00:00Z",
    [young]: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  };
  const service = createDashboardService({
    projectRoot: "/projects",
    wtPath: "/wt",
    sizeService,
    discover: async () => ["/repo"],
    runner: async (_command, args) =>
      args.includes("list") ? result(JSON.stringify(payload)) : result("", 1),
    readCreated: async (path) => created[path] ?? null,
  });
  try {
    await service.refresh();
    const rows = service.getSnapshot().rows;
    expect(rows.map((row) => [row.path, row.createdAt, row.verdict, row.reason])).toEqual([
      [old, created[old], "Safe", "No commits beyond main."],
      [young, created[young], "Review", "Created 2h ago, so it may still be in use."],
    ]);
  } finally {
    await service.close();
  }
});
