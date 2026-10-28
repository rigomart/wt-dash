import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CommandRunner, SizeEntry, SizeService, SizeSignature } from "./types";

/** A saved size older than this is measured again even when its folders look unchanged. */
export const SIZE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

async function readSignature(path: string): Promise<SizeSignature | null> {
  try {
    const [folder, nodeModulesMtimeMs] = await Promise.all([
      stat(path),
      stat(join(path, "node_modules")).then(
        (info) => info.mtimeMs,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      ),
    ]);
    return { mtimeMs: folder.mtimeMs, nodeModulesMtimeMs };
  } catch {
    return null;
  }
}

function parseSignature(raw: unknown): SizeSignature | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { mtimeMs, nodeModulesMtimeMs } = raw as Record<string, unknown>;
  if (
    !Number.isFinite(mtimeMs) ||
    (nodeModulesMtimeMs !== null && !Number.isFinite(nodeModulesMtimeMs))
  )
    return undefined;
  return { mtimeMs: mtimeMs as number, nodeModulesMtimeMs: nodeModulesMtimeMs as number | null };
}

export function createSizeService(
  cachePath: string,
  runner: CommandRunner,
  concurrency = 6,
  now: () => number = Date.now,
): SizeService {
  const cache = new Map<string, SizeEntry>();
  const firstWaiters: Array<() => void> = [];
  const uncachedWaiters: Array<() => void> = [];
  const cachedWaiters: Array<() => void> = [];
  const tasks = new Set<Promise<SizeEntry | null>>();
  const inFlight = new Map<string, Promise<SizeEntry | null>>();
  const abort = new AbortController();
  let active = 0;
  let closed = false;
  let writeNumber = 0;
  let writes: Promise<void> = Promise.resolve();

  async function acquire(hadEntry: boolean, first: boolean): Promise<boolean> {
    if (closed) return false;
    if (active < concurrency) {
      active++;
      return true;
    }
    await new Promise<void>((resolve) =>
      (first ? firstWaiters : hadEntry ? cachedWaiters : uncachedWaiters).push(resolve),
    );
    return !closed;
  }

  function release(): void {
    if (closed) {
      active--;
      return;
    }
    const next = firstWaiters.shift() ?? uncachedWaiters.shift() ?? cachedWaiters.shift();
    if (next) next();
    else active--;
  }

  function persist(): Promise<void> {
    writes = writes
      .then(async () => {
        await mkdir(dirname(cachePath), { recursive: true });
        const temporary = `${cachePath}.tmp-${process.pid}-${++writeNumber}`;
        await writeFile(temporary, JSON.stringify(Object.fromEntries(cache), null, 2));
        await rename(temporary, cachePath);
      })
      .catch(() => {
        // A cache write failure must not hide a measured worktree.
      });
    return writes;
  }

  async function isFresh(path: string): Promise<boolean> {
    const entry = cache.get(path);
    if (!entry?.signature) return false;
    const age = now() - Date.parse(entry.measuredAt);
    if (!(age >= 0 && age < SIZE_MAX_AGE_MS)) return false;
    const current = await readSignature(path);
    return (
      current?.mtimeMs === entry.signature.mtimeMs &&
      current.nodeModulesMtimeMs === entry.signature.nodeModulesMtimeMs
    );
  }

  async function run(path: string, first = false): Promise<SizeEntry | null> {
    if (!(await acquire(cache.has(path), first))) return null;
    try {
      // Stat before du, so a change made while du runs is caught next time.
      const signature = await readSignature(path);
      if (closed) return null;
      const result = await runner("/usr/bin/du", ["-sk", path], abort.signal);
      if (result.exitCode !== 0) return null;
      const match = /^(\d+)\s/.exec(result.stdout);
      if (!match) return null;
      const sizeKiB = Number(match[1]);
      if (!Number.isSafeInteger(sizeKiB)) return null;
      const entry: SizeEntry = { sizeKiB, measuredAt: new Date(now()).toISOString() };
      if (signature) entry.signature = signature;
      cache.set(path, entry);
      await persist();
      return entry;
    } catch {
      return null;
    } finally {
      release();
    }
  }

  function track(task: Promise<SizeEntry | null>): Promise<SizeEntry | null> {
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
    return task;
  }

  return {
    async load() {
      cache.clear();
      try {
        const parsed = JSON.parse(await readFile(cachePath, "utf8")) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
        for (const [path, raw] of Object.entries(parsed)) {
          if (typeof raw !== "object" || raw === null) continue;
          const entry = raw as Record<string, unknown>;
          if (
            Number.isSafeInteger(entry.sizeKiB) &&
            (entry.sizeKiB as number) >= 0 &&
            typeof entry.measuredAt === "string"
          ) {
            const loaded: SizeEntry = {
              sizeKiB: entry.sizeKiB as number,
              measuredAt: entry.measuredAt,
            };
            const signature = parseSignature(entry.signature);
            if (signature) loaded.signature = signature;
            cache.set(path, loaded);
          }
        }
      } catch {
        // Missing and corrupt cache files both mean there is no saved size.
      }
    },
    get(path) {
      return cache.get(path) ?? null;
    },
    measure(path) {
      if (closed) return Promise.resolve(null);
      return track(run(path));
    },
    measureIfStale(path, first = false) {
      if (closed) return Promise.resolve(null);
      const pending = inFlight.get(path);
      if (pending) return pending;
      const task = track(isFresh(path).then((fresh) => (fresh ? null : run(path, first))));
      inFlight.set(path, task);
      void task.finally(() => inFlight.delete(path));
      return task;
    },
    async close() {
      closed = true;
      abort.abort();
      for (const resume of [
        ...firstWaiters.splice(0),
        ...uncachedWaiters.splice(0),
        ...cachedWaiters.splice(0),
      ])
        resume();
      await Promise.allSettled(tasks);
      await writes;
    },
  };
}
