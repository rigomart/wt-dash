import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCacheFile } from "../src/core/cache-file";

const roots: string[] = [];
async function folder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dash-cache-file-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const realRename = fs.rename;
type Counts = Record<string, number>;
function counts(path: string) {
  return createCacheFile<Counts>(path, {
    parse: (raw) => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("bad");
      return raw as Counts;
    },
    serialize: (value) => value,
    empty: () => ({}),
  });
}

test("saves a value and loads it back", async () => {
  const path = join(await folder(), "counts.json");
  await counts(path).save({ a: 1, b: 2 });
  expect(await readFile(path, "utf8")).toBe(JSON.stringify({ a: 1, b: 2 }, null, 2));
  expect(await counts(path).load()).toEqual({ a: 1, b: 2 });
});

test("creates the missing folder when saving", async () => {
  const path = join(await folder(), "deep", "er", "counts.json");
  await counts(path).save({ a: 1 });
  expect(await counts(path).load()).toEqual({ a: 1 });
});

test("loads the empty value when the file is missing", async () => {
  const path = join(await folder(), "counts.json");
  expect(await counts(path).load()).toEqual({});
});

test("loads the empty value when the file is not JSON or fails to parse", async () => {
  const path = join(await folder(), "counts.json");
  await writeFile(path, "{ not json");
  expect(await counts(path).load()).toEqual({});
  await writeFile(path, "[1, 2]");
  expect(await counts(path).load()).toEqual({});
});

test("saves made during a write share one more write and the last value wins", async () => {
  const root = await folder();
  const path = join(root, "counts.json");
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const writing = new Promise<void>((resolve) => (reached = resolve));
  let renames = 0;
  const spy = spyOn(fs, "rename").mockImplementation(async (...args) => {
    if (++renames === 1) {
      reached();
      await blocked;
    }
    return realRename(...args);
  });
  try {
    const file = counts(path);
    const saves = [file.save({ n: 1 })];
    await writing;
    saves.push(file.save({ n: 2 }), file.save({ n: 3 }), file.save({ n: 4 }));
    release();
    await Promise.all(saves);
    expect(renames).toBe(2);
    expect(await counts(path).load()).toEqual({ n: 4 });
  } finally {
    spy.mockRestore();
  }
});

test("a save resolves only after its value is on disk", async () => {
  const path = join(await folder(), "counts.json");
  const file = counts(path);
  const first = file.save({ n: 1 });
  const second = file.save({ n: 2 });
  await first;
  expect(await counts(path).load()).toEqual({ n: 2 });
  await second;
});

test("serializes the value as it is when the write starts", async () => {
  const path = join(await folder(), "counts.json");
  const shared: Counts = { n: 1 };
  const file = counts(path);
  const saved = file.save(shared);
  shared.n = 2;
  await saved;
  expect(await counts(path).load()).toEqual({ n: 2 });
});

test("flush waits for a running write and resolves when idle", async () => {
  const path = join(await folder(), "counts.json");
  const file = counts(path);
  await file.flush();
  void file.save({ n: 1 });
  await file.flush();
  expect(await counts(path).load()).toEqual({ n: 1 });
});

test("leaves only the cache file in the folder after the writes", async () => {
  const root = await folder();
  const path = join(root, "counts.json");
  const file = counts(path);
  await Promise.all([1, 2, 3, 4, 5].map((n) => file.save({ n })));
  await file.save({ n: 6 });
  expect(await readdir(root)).toEqual(["counts.json"]);
});

test("keeps the old file whole while a new one is written beside it", async () => {
  const root = await folder();
  const path = join(root, "counts.json");
  const file = counts(path);
  await file.save({ n: 1 });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const writing = new Promise<void>((resolve) => (reached = resolve));
  const spy = spyOn(fs, "rename").mockImplementation(async (...args) => {
    reached();
    await blocked;
    return realRename(...args);
  });
  try {
    const saved = file.save({ n: 2 });
    await writing;
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ n: 1 });
    expect((await readdir(root)).filter((name) => name.includes(".tmp-"))).toHaveLength(1);
    release();
    await saved;
    expect(await counts(path).load()).toEqual({ n: 2 });
    expect(await readdir(root)).toEqual(["counts.json"]);
  } finally {
    spy.mockRestore();
  }
});

test("swallows a failed write and writes again on the next save", async () => {
  const root = await folder();
  const path = join(root, "counts.json");
  const file = counts(path);
  const spy = spyOn(fs, "rename").mockRejectedValueOnce(new Error("disk full"));
  try {
    await file.save({ n: 1 });
  } finally {
    spy.mockRestore();
  }
  expect(await counts(path).load()).toEqual({});
  await file.save({ n: 2 });
  expect(await counts(path).load()).toEqual({ n: 2 });
});
