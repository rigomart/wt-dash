import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProofCache, proofKey } from "../../src/core/github/cache";
import type { ForgeProof } from "../../src/core/types";

const roots: string[] = [];
async function file(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dash-proofs-"));
  roots.push(root);
  return join(root, "cache", "pull-requests.json");
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const repo = { owner: "Acme", name: "App" };
const proof = (tip: string, pr = 7): ForgeProof => ({
  kind: "proven",
  tip,
  pr,
  mergedAt: "2026-10-30T12:00:00Z",
  base: "main",
  by: "commit",
});
const A = "a".repeat(40);
const B = "b".repeat(40);

test("proofs are saved under owner/name@tip and load back in a later run", async () => {
  const path = await file();
  const cache = createProofCache(path);
  await cache.load();
  cache.add(repo, [proof(A), { ...proof(B, 8), by: "stacked", base: "trunk" }]);
  await cache.close();
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    [`acme/app@${A}`]: {
      tip: A,
      pr: 7,
      mergedAt: "2026-10-30T12:00:00Z",
      base: "main",
      by: "commit",
    },
    [`acme/app@${B}`]: {
      tip: B,
      pr: 8,
      mergedAt: "2026-10-30T12:00:00Z",
      base: "trunk",
      by: "stacked",
    },
  });
  const later = createProofCache(path);
  await later.load();
  expect(later.get({ owner: "acme", name: "app" }, A)).toEqual(proof(A));
  expect(later.get(repo, B)?.by).toBe("stacked");
  expect(later.get({ owner: "acme", name: "other" }, A)).toBeNull();
  expect(proofKey(repo, A)).toBe(`acme/app@${A}`);
});

test("a missing or corrupt file is empty, and malformed entries are dropped", async () => {
  const path = await file();
  const cache = createProofCache(path);
  await cache.load();
  expect(cache.get(repo, A)).toBeNull();

  await Bun.write(path, "{ not json");
  await cache.load();
  expect(cache.get(repo, A)).toBeNull();

  const good = { tip: A, pr: 7, mergedAt: "2026-10-30T12:00:00Z", base: "main", by: "commit" };
  await Bun.write(
    path,
    JSON.stringify({
      [`acme/app@${A}`]: good,
      [`acme/app@${B}`]: { ...good, tip: B, by: "guess" },
      [`acme/other@${B}`]: { ...good, tip: A },
      [`acme/third@${B}`]: { ...good, tip: B, pr: -1 },
      [`acme/fourth@${B}`]: { ...good, tip: B, mergedAt: null },
      [`acme/fifth@${B}`]: "proven",
    }),
  );
  await cache.load();
  expect(cache.get(repo, A)).toEqual(proof(A));
  for (const name of ["app", "other", "third", "fourth", "fifth"])
    expect(cache.get({ owner: "acme", name }, B)).toBeNull();
});

test("adding nothing writes nothing", async () => {
  const path = await file();
  const cache = createProofCache(path);
  cache.add(repo, []);
  await cache.close();
  expect(await Bun.file(path).exists()).toBe(false);
});
