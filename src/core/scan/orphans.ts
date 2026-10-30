import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { assess } from "../assess";
import { ORPHANS, type OrphanCause, type WorktreeFacts, type WorktreeRow } from "../types";
import { toolForPath } from "../worktrunk/list";
import type { LinkedWorktrees } from "./discovery";

export interface Orphan {
  path: string;
  cause: OrphanCause;
}

/** The file Codex leaves in each `~/.codex/worktrees/<id>` folder. */
export const CODEX_NAME_FILE = ".codex-worktree-name";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

async function subfolders(folder: string): Promise<string[]> {
  try {
    const entries = await readdir(folder, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(folder, entry.name));
  } catch {
    return [];
  }
}

/** Whether `folder` sits where Codex keeps its `<id>` folders: `.codex/worktrees/<id>`. */
export function isCodexShellLocation(folder: string): boolean {
  const parent = dirname(folder);
  return basename(parent) === "worktrees" && basename(dirname(parent)) === ".codex";
}

async function isEmptyShell(folder: string): Promise<boolean> {
  if (!isCodexShellLocation(folder)) return false;
  const entries = (await readdir(folder, { withFileTypes: true })).filter(
    (entry) => entry.name !== ".DS_Store",
  );
  return entries.length === 1 && entries[0]!.name === CODEX_NAME_FILE && entries[0]!.isFile();
}

/** The repository that holds a `<repo>/.git/worktrees/<name>` or bare `<repo>/worktrees/<name>` record. */
function recordRepo(gitdir: string): string | null {
  const records = dirname(gitdir);
  if (basename(records) !== "worktrees") return null;
  const holder = dirname(records);
  return basename(holder) === ".git" ? dirname(holder) : holder;
}

/**
 * Why no repository knows `folder`, or null when it isn't an orphan or can't be read. Plain file reads, never
 * Git: Git run inside an orphan can walk up into a parent repository.
 */
export async function readOrphanCause(folder: string): Promise<OrphanCause | null> {
  try {
    if (!(await lstat(folder)).isDirectory()) return null;
    const link = await lstat(join(folder, ".git")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!link) return (await isEmptyShell(folder)) ? { kind: "emptyShell" } : null;
    if (!link.isFile()) return null;
    const line = /^gitdir: (.+)$/m.exec(await readFile(join(folder, ".git"), "utf8"))?.[1]?.trim();
    if (!line) return null;
    const gitdir = resolve(folder, line);
    if (await exists(gitdir)) return null;
    const repo = recordRepo(gitdir);
    return {
      kind: "gitdirMissing",
      gitdir,
      repo,
      repoExists: repo !== null && (await exists(repo)),
    };
  } catch {
    return null;
  }
}

const real = (path: string) => realpath(path).catch(() => path);

/**
 * Folders in the agents' worktree locations that no repository's Git records point to: `.claude/worktrees`
 * in each repo, and Codex's, t3's and t3 lines' folders under `home`. A folder a scanned repo still records
 * is skipped even when its own `.git` file is stale, as after the repo moved. Records that can't be read may
 * be such a record, so they hide every folder with a stale `.git` file whose record has the same name, or
 * all of them when a repo's records can't be listed.
 */
export async function findOrphans(
  home: string,
  repos: Array<{ path: string; linked: LinkedWorktrees | null }>,
): Promise<Orphan[]> {
  const codex = join(home, ".codex", "worktrees");
  const [claude, codexIds, t3Groups, lines] = await Promise.all([
    Promise.all(repos.map((repo) => subfolders(join(repo.path, ".claude", "worktrees")))),
    subfolders(codex),
    subfolders(join(home, ".t3", "worktrees")),
    subfolders(join(home, ".t3-lines", "lines", "worktrees")),
  ]);
  const nested = await Promise.all([...codexIds, ...t3Groups].map(subfolders));
  const worktrees = [...new Set([...claude.flat(), ...nested.flat(), ...lines])];
  const [found, shells, recorded] = await Promise.all([
    Promise.all(worktrees.map(async (path) => ({ path, cause: await readOrphanCause(path) }))),
    Promise.all(codexIds.map(async (path) => ({ path, cause: await readOrphanCause(path) }))),
    Promise.all(repos.flatMap((repo) => repo.linked?.paths ?? []).map(real)),
  ]);
  const known = new Set(recorded);
  const unlisted = repos.some((repo) => repo.linked === null);
  const unread = new Set(repos.flatMap((repo) => repo.linked?.unread ?? []));
  const orphans = [
    ...found.filter(
      ({ cause }) =>
        cause?.kind === "gitdirMissing" && !unlisted && !unread.has(basename(cause.gitdir)),
    ),
    ...shells.filter((item) => item.cause?.kind === "emptyShell"),
  ] as Orphan[];
  const unknown = await Promise.all(
    orphans.map(async (orphan) => !known.has(await real(orphan.path))),
  );
  return orphans.filter((_, index) => unknown[index]).sort((a, b) => a.path.localeCompare(b.path));
}

/** A dashboard row for an orphan folder; every Git field is null. */
export function orphanRow({ path, cause }: Orphan): WorktreeRow {
  const facts: WorktreeFacts = {
    id: `${ORPHANS}\0${path}`,
    kind: "orphan",
    repoPath: ORPHANS,
    repoName: "Orphaned folders",
    path,
    branch: null,
    headSha: null,
    committedAt: null,
    createdAt: null,
    marker: null,
    markerSetAt: null,
    tool: toolForPath(path, (cause.kind === "gitdirMissing" && cause.repo) || ORPHANS),
    changes: null,
    upstreamAhead: null,
    mainState: null,
    integrationReason: null,
    lockReason: null,
    mainAhead: null,
    mainBehind: null,
    mainDiff: null,
    subject: null,
    description: null,
    vars: null,
    defaultBranch: null,
    mainBase: null,
    locked: false,
    prunable: false,
    operation: null,
    orphan: cause,
  };
  const { verdict, reason } = assess(facts);
  return { ...facts, sizeKiB: null, sizeMeasuredAt: null, verdict, reason };
}

export function sameCause(a: OrphanCause | null | undefined, b: OrphanCause | null | undefined) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "emptyShell" || b.kind === "emptyShell") return true;
  return a.gitdir === b.gitdir && a.repo === b.repo && a.repoExists === b.repoExists;
}
