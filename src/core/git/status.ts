import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FileReport } from "../removal/types";
import { failure } from "../process";
import type { CommandRunner, WorktreeRow } from "../types";

const disposablePath =
  /(^|\/)(node_modules|\.next|\.turbo|\.vite|\.cache|dist|build|target|coverage)\/?$|(^|\/)\.DS_Store$|\.tsbuildinfo$/;

function statusFiles(stdout: string): FileReport {
  const report: FileReport = { localFiles: [], ignoredFiles: [], disposableIgnored: 0 };
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    if (!line.startsWith("!! ")) report.localFiles.push(line);
    else if (disposablePath.test(line.slice(3))) report.disposableIgnored++;
    else report.ignoredFiles.push(line.slice(3));
  }
  return report;
}

export async function readFiles(row: WorktreeRow, runner: CommandRunner): Promise<FileReport> {
  if (row.path === null) throw new Error("A branch without a worktree has no files");
  const status = await runner("git", [
    "-C",
    row.path,
    "status",
    "--porcelain=v1",
    "--ignored",
    "--untracked-files=normal",
  ]);
  if (status.exitCode !== 0)
    throw new Error(
      `Could not inspect local files: ${status.stderr.trim() || "git status failed"}`,
    );
  return statusFiles(status.stdout);
}

/** Operation names match Worktrunk's. */
const operationMarkers = [
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
  ["MERGE_HEAD", "merge"],
  ["CHERRY_PICK_HEAD", "cherry_pick"],
  ["REVERT_HEAD", "revert"],
  // A multi-commit cherry-pick or revert can stop with only sequencer/ left, without
  // CHERRY_PICK_HEAD or REVERT_HEAD; its todo names which one.
  ["sequencer", "cherry_pick"],
  ["BISECT_LOG", "bisect"],
] as const;
async function sequencerOperation(directory: string): Promise<string> {
  const todo = await readFile(join(directory, "todo"), "utf8").catch(() => "");
  const command = todo
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"))
    ?.split(/\s+/)[0];
  return command === "revert" || command === "r" ? "revert" : "cherry_pick";
}
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function readOperation(path: string, runner: CommandRunner): Promise<string | null> {
  const result = await runner("git", [
    "-C",
    path,
    "rev-parse",
    ...operationMarkers.flatMap(([marker]) => ["--git-path", marker]),
  ]);
  if (result.exitCode !== 0) throw failure("git rev-parse", result);
  const markerPaths = result.stdout.split("\n").filter(Boolean);
  if (markerPaths.length !== operationMarkers.length)
    throw new Error("git rev-parse did not report the Git operation markers");
  for (const [index, [marker, operation]] of operationMarkers.entries()) {
    const markerPath = resolve(path, markerPaths[index]!);
    if (!(await exists(markerPath))) continue;
    return marker === "sequencer" ? sequencerOperation(markerPath) : operation;
  }
  return null;
}
