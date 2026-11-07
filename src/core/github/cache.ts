import { createCacheFile } from "../cache-file";
import type { ForgeProof, ForgeProofKind } from "../types";
import type { GitHubRepo } from "./remote";

/**
 * Proofs GitHub gave, kept forever because a merged pull request never changes. Only proofs are kept: a tip
 * GitHub didn't know may be merged later.
 */
export interface ProofCache {
  load(): Promise<void>;
  get(repo: GitHubRepo, tip: string): ForgeProof | null;
  /** Saves the proofs in the background; `close` waits for the write. */
  add(repo: GitHubRepo, proofs: ForgeProof[]): void;
  close(): Promise<void>;
}

/** `owner/name@<tip>`, lowercased, as GitHub matches names without case. */
export const proofKey = (repo: GitHubRepo, tip: string) =>
  `${repo.owner}/${repo.name}@${tip}`.toLowerCase();

const kinds: ForgeProofKind[] = ["commit", "tree", "stacked"];

function parseProofs(raw: unknown): Map<string, ForgeProof> {
  const proofs = new Map<string, ForgeProof>();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return proofs;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "object" || value === null) continue;
    const { tip, pr, mergedAt, base, by } = value as Record<string, unknown>;
    if (
      typeof tip === "string" &&
      /^[0-9a-f]{40}$/.test(tip) &&
      key.endsWith(`@${tip}`) &&
      Number.isSafeInteger(pr) &&
      (pr as number) > 0 &&
      typeof mergedAt === "string" &&
      typeof base === "string" &&
      kinds.includes(by as ForgeProofKind)
    )
      proofs.set(key, {
        kind: "proven",
        tip,
        pr: pr as number,
        mergedAt,
        base,
        by: by as ForgeProofKind,
      });
  }
  return proofs;
}

export function createProofCache(path: string): ProofCache {
  const proofs = new Map<string, ForgeProof>();
  const file = createCacheFile<Map<string, ForgeProof>>(path, {
    parse: parseProofs,
    serialize: (entries) =>
      Object.fromEntries(
        [...entries].map(([key, { tip, pr, mergedAt, base, by }]) => [
          key,
          { tip, pr, mergedAt, base, by },
        ]),
      ),
    empty: () => new Map(),
  });
  return {
    async load() {
      proofs.clear();
      for (const [key, proof] of await file.load()) proofs.set(key, proof);
    },
    get(repo, tip) {
      return proofs.get(proofKey(repo, tip)) ?? null;
    },
    add(repo, added) {
      if (!added.length) return;
      for (const proof of added) proofs.set(proofKey(repo, proof.tip), proof);
      void file.save(proofs);
    },
    close: () => file.flush(),
  };
}
