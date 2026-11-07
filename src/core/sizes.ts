import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createCacheFile } from "./cache-file";
import type { CommandRunner, SizeEntry, SizeService, SizeSignature } from "./types";

/** A saved size older than this is measured again even when its folders look unchanged. */
export const SIZE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Apple's du on macOS, where a GNU du from Homebrew may come first on PATH. */
const du = process.platform === "darwin" ? "/usr/bin/du" : "du";

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

function parseEntries(parsed: unknown): Map<string, SizeEntry> {
  const entries = new Map<string, SizeEntry>();
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return entries;
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
      entries.set(path, loaded);
    }
  }
  return entries;
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
  const newestByPath = new Map<string, number>();
  const abort = new AbortController();
  const file = createCacheFile<Map<string, SizeEntry>>(cachePath, {
    parse: parseEntries,
    serialize: (entries) => Object.fromEntries(entries),
    empty: () => new Map(),
  });
  let requests = 0;
  let active = 0;
  let closed = false;

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

  async function run(path: string, ticket: number, first = false): Promise<SizeEntry | null> {
    newestByPath.set(path, Math.max(ticket, newestByPath.get(path) ?? 0));
    if (!(await acquire(cache.has(path), first))) return null;
    let saved = Promise.resolve();
    let measured: SizeEntry | null = null;
    try {
      // Stat before du, so a change made while du runs is caught next time.
      const signature = await readSignature(path);
      if (closed) return null;
      const result = await runner(du, ["-sk", path], abort.signal);
      if (closed || newestByPath.get(path) !== ticket || result.exitCode !== 0) return null;
      const match = /^(\d+)\s/.exec(result.stdout);
      if (!match) return null;
      const sizeKiB = Number(match[1]);
      if (!Number.isSafeInteger(sizeKiB)) return null;
      const entry: SizeEntry = { sizeKiB, measuredAt: new Date(now()).toISOString() };
      if (signature) entry.signature = signature;
      cache.set(path, entry);
      saved = file.save(cache);
      measured = entry;
    } catch {
      return null;
    } finally {
      release();
    }
    await saved;
    return !closed && newestByPath.get(path) === ticket ? measured : null;
  }

  function track(task: Promise<SizeEntry | null>): Promise<SizeEntry | null> {
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
    return task;
  }

  return {
    async load() {
      cache.clear();
      for (const [path, entry] of await file.load()) cache.set(path, entry);
    },
    get(path) {
      return cache.get(path) ?? null;
    },
    measure(path) {
      if (closed) return Promise.resolve(null);
      const ticket = ++requests;
      return track(run(path, ticket));
    },
    measureIfStale(path, first = false) {
      if (closed) return Promise.resolve(null);
      const pending = inFlight.get(path);
      if (pending) return pending;
      const ticket = ++requests;
      const task = track(isFresh(path).then((fresh) => (fresh ? null : run(path, ticket, first))));
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
      await file.flush();
    },
  };
}
