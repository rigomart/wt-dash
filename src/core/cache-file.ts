import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface CacheFileCodec<T> {
  /** Turns the parsed JSON into a value. Throwing is the same as a corrupt file. */
  parse(raw: unknown): T;
  /** Turns the value into JSON data, read when the write starts. */
  serialize(value: T): unknown;
  /** The value when the file is missing or corrupt. */
  empty(): T;
}

export interface CacheFile<T> {
  load(): Promise<T>;
  /**
   * Writes the value. While a write is running, later saves share one more
   * write that reads the newest value, and every save resolves once its
   * value, or a newer one, is on disk. Write errors are swallowed.
   */
  save(value: T): Promise<void>;
  /** Resolves when no write is running. */
  flush(): Promise<void>;
}

/** A JSON cache file written through a temporary file and a rename, so a reader never sees half a file. */
export function createCacheFile<T>(path: string, codec: CacheFileCodec<T>): CacheFile<T> {
  let writeNumber = 0;
  let latest: { value: T } | null = null;
  let dirty = false;
  let writes: Promise<void> | null = null;

  return {
    async load() {
      try {
        return codec.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
      } catch {
        // Missing and corrupt cache files both mean there is nothing saved.
        return codec.empty();
      }
    },
    save(value) {
      latest = { value };
      dirty = true;
      writes ??= Promise.resolve().then(async () => {
        try {
          while (dirty) {
            dirty = false;
            try {
              await mkdir(dirname(path), { recursive: true });
              const temporary = `${path}.tmp-${process.pid}-${++writeNumber}`;
              // A save during mkdir is covered by this write, which reads the newest value.
              dirty = false;
              await writeFile(temporary, JSON.stringify(codec.serialize(latest!.value), null, 2));
              await rename(temporary, path);
            } catch {}
          }
        } finally {
          writes = null;
        }
      });
      return writes;
    },
    async flush() {
      await writes;
    },
  };
}
