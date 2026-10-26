import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CommandRunner, SizeEntry, SizeService } from "./types";

export function createSizeService(
  cachePath: string,
  runner: CommandRunner,
  concurrency = 2,
): SizeService {
  const cache = new Map<string, SizeEntry>();
  const waiters: Array<() => void> = [];
  const tasks = new Set<Promise<SizeEntry | null>>();
  const abort = new AbortController();
  let active = 0;
  let closed = false;
  let writeNumber = 0;
  let writes: Promise<void> = Promise.resolve();

  async function acquire(): Promise<boolean> {
    if (closed) return false;
    if (active < concurrency) {
      active++;
      return true;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
    return !closed;
  }

  function release(): void {
    if (closed) {
      active--;
      return;
    }
    const next = waiters.shift();
    if (next) next();
    else active--;
  }

  function persist(): Promise<void> {
    writes = writes.then(async () => {
      await mkdir(dirname(cachePath), { recursive: true });
      const temporary = `${cachePath}.tmp-${process.pid}-${++writeNumber}`;
      await writeFile(temporary, JSON.stringify(Object.fromEntries(cache), null, 2));
      await rename(temporary, cachePath);
    }).catch(() => {
      // A cache write failure must not hide a measured worktree.
    });
    return writes;
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
          if (Number.isSafeInteger(entry.sizeKiB) && (entry.sizeKiB as number) >= 0 && typeof entry.measuredAt === "string") {
            cache.set(path, { sizeKiB: entry.sizeKiB as number, measuredAt: entry.measuredAt });
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
      const task = (async (): Promise<SizeEntry | null> => {
        if (!await acquire()) return null;
        try {
          const result = await runner("/usr/bin/du", ["-sk", path], abort.signal);
          if (result.exitCode !== 0) return null;
          const match = /^(\d+)\s/.exec(result.stdout);
          if (!match) return null;
          const sizeKiB = Number(match[1]);
          if (!Number.isSafeInteger(sizeKiB)) return null;
          const entry = { sizeKiB, measuredAt: new Date().toISOString() };
          cache.set(path, entry);
          await persist();
          return entry;
        } catch {
          return null;
        } finally {
          release();
        }
      })();
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
      return task;
    },
    async close() {
      closed = true;
      abort.abort();
      for (const resume of waiters.splice(0)) resume();
      await Promise.allSettled([...tasks]);
      await writes;
    },
  };
}
