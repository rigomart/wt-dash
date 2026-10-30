import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { isRepo } from "./discovery";

/** The file that keeps every repository wt-dash has found: `wt-dash/repos.json` in `$XDG_STATE_HOME`, or in `~/.local/state`. */
export function savedReposFile(
  home: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const state = env.XDG_STATE_HOME;
  return join(
    state && isAbsolute(state) ? state : join(home, ".local", "state"),
    "wt-dash",
    "repos.json",
  );
}

function parse(text: string): string[] {
  try {
    const { repos } = JSON.parse(text) as { repos?: unknown };
    if (!Array.isArray(repos)) return [];
    return repos.filter((repo): repo is string => typeof repo === "string" && isAbsolute(repo));
  } catch {
    return [];
  }
}

async function check(text: string): Promise<{ listed: string[]; unreadable: string[] }> {
  const repos = [...new Set(parse(text))];
  const found = await Promise.all(repos.map(isRepo));
  return {
    listed: repos.filter((_, index) => found[index] === true),
    unreadable: repos.filter((_, index) => found[index] === null),
  };
}

const read = (file: string) => readFile(file, "utf8").catch(() => "");

/** The repositories saved in `file` that are still there, sorted. A missing, unreadable or corrupt file holds none. */
export async function readSavedRepos(file: string): Promise<string[]> {
  return (await check(await read(file))).listed.sort();
}

let writeNumber = 0;

/**
 * Adds `found` to the repositories saved in `file`, drops the saved ones that are gone or no longer repositories,
 * and returns the ones to list, sorted: all but those that can't be read right now. Writes the file atomically, only
 * when that changes it and never to hold nothing, and ignores a failed write.
 */
export async function rememberRepos(file: string, found: string[]): Promise<string[]> {
  const text = await read(file);
  const { listed, unreadable } = await check(text);
  const repos = [...new Set([...listed, ...unreadable, ...found])].sort();
  const next = `${JSON.stringify({ repos }, null, 2)}\n`;
  if (next !== text && (repos.length > 0 || text !== "")) {
    const temporary = `${file}.tmp-${process.pid}-${++writeNumber}`;
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(temporary, next);
      await rename(temporary, file);
    } catch {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
  return [...new Set([...listed, ...found])].sort();
}
