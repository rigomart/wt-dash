import { lstat, readdir, rm, rmdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CODEX_NAME_FILE, isCodexShellLocation, readOrphanCause, sameCause } from "../scan/orphans";
import type { OrphanCause, WorktreeRow } from "../types";
import type { RemovalEntry } from "./types";

async function folderId(path: string): Promise<string> {
  const { dev, ino } = await stat(path);
  return `${dev}:${ino}`;
}

/**
 * Reads the folder again with the rule that found it; null when it is still the orphan the row shows and,
 * given `id`, the same folder the preview saw.
 */
export async function recheckOrphan(row: WorktreeRow, id?: string): Promise<string | null> {
  const path = row.path!;
  const gone = await lstat(path).then(
    () => false,
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
  if (gone) return "it is gone";
  if (!sameCause(await readOrphanCause(path), row.orphan))
    return "it changed; refresh and preview again";
  if (id !== undefined && (await folderId(path).catch(() => null)) !== id)
    return "it changed; refresh and preview again";
  return null;
}

export async function planOrphan(row: WorktreeRow): Promise<RemovalEntry> {
  const blockedReason = await recheckOrphan(row);
  return {
    row,
    blockedReason,
    localFiles: [],
    ignoredFiles: [],
    disposableIgnored: 0,
    requiresDiscard: false,
    branchWillBeRetained: false,
    ...(blockedReason ? {} : { folderId: await folderId(row.path!) }),
  };
}

async function deleteShell(folder: string): Promise<void> {
  for (const name of [CODEX_NAME_FILE, ".DS_Store"]) await rm(join(folder, name), { force: true });
  await rmdir(folder);
}

/**
 * Deletes an orphan folder with node:fs rather than Git, which could walk up into a parent repository, then the
 * Codex `<id>` folder around it when only Codex's name file, or nothing, is left. Symlinks inside are removed,
 * not followed. An `<id>` folder that can't be deleted is listed as an empty shell on the next scan.
 */
export async function deleteOrphan(path: string, cause: OrphanCause): Promise<void> {
  if (cause.kind === "emptyShell") return deleteShell(path);
  await rm(path, { recursive: true });
  const parent = dirname(path);
  if (!isCodexShellLocation(parent)) return;
  const left = await readdir(parent).catch(() => null);
  if (left && (!left.length || (await readOrphanCause(parent))?.kind === "emptyShell"))
    await deleteShell(parent).catch(() => {});
}
