import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SCAN_FOLDERS, type CliOptions } from "./cli";
import { runCommand } from "./core/process";
import { findRepos, type RepoSource } from "./core/scan/discovery";
import { AGENT_FOLDERS } from "./core/worktrunk/list";

const minimumWorktrunk = [0, 80, 0];
const platformNames: Record<string, string> = { darwin: "macOS", linux: "Linux" };

export function platformName(platform: string = process.platform): string | undefined {
  return platformNames[platform];
}

async function executable(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile() && (await access(path, constants.X_OK).then(() => true));
  } catch {
    return false;
  }
}

async function readableFolder(folder: string): Promise<string | null> {
  try {
    if (!(await stat(folder)).isDirectory()) return null;
    await access(folder, constants.R_OK | constants.X_OK);
    return await realpath(folder);
  } catch {
    return null;
  }
}

async function repoSources(options: CliOptions, home: string): Promise<RepoSource[]> {
  const sources: RepoSource[] = [];
  const add = (source: RepoSource) => {
    if (!sources.some(({ folder }) => folder === source.folder)) sources.push(source);
  };
  for (const root of options.roots) {
    const folder = await readableFolder(root);
    if (folder) add({ kind: "scan", folder });
    else if (!options.defaults)
      throw new Error(
        `Scan folder is missing or unreadable: ${root}\nSupply a folder, for example: wt-dash ~/code`,
      );
  }
  if (options.defaults)
    for (const { folder: relative, levels } of AGENT_FOLDERS) {
      const folder = await readableFolder(join(home, relative));
      if (folder) add({ kind: "agent", folder, levels });
    }
  return sources;
}

export async function prepareStartup(
  options: CliOptions,
  environment: { platform?: string; path?: string; home?: string } = {},
) {
  const platform = environment.platform ?? process.platform;
  if (!platformName(platform)) throw new Error("This release supports macOS and Linux only.");
  const home = environment.home ?? homedir();
  const sources = await repoSources(options, home);

  const path = environment.path ?? process.env.PATH ?? "";
  const gitPath = Bun.which("git", { PATH: path });
  if (!gitPath)
    throw new Error(
      platform === "darwin"
        ? "Git was not found on PATH. Install Apple's command line tools: xcode-select --install"
        : "Git was not found on PATH. Install it with your distribution's package manager.",
    );
  const candidates = options.wtPath
    ? [options.wtPath]
    : [
        Bun.which("wt", { PATH: path }),
        "/opt/homebrew/bin/wt",
        "/usr/local/bin/wt",
        "/home/linuxbrew/.linuxbrew/bin/wt",
        join(home, ".cargo/bin/wt"),
      ].filter((candidate): candidate is string => candidate !== null);
  let wtPath: string | undefined;
  for (const candidate of candidates) {
    if (await executable(candidate)) {
      wtPath = candidate;
      break;
    }
  }
  if (!wtPath)
    throw new Error(
      "Worktrunk was not found. Install it with: brew install worktrunk, or cargo install worktrunk\nOr supply its executable with --wt-path /path/to/wt",
    );

  async function readVersion(command: string, name: string): Promise<string> {
    try {
      const result = await runCommand(command, ["--version"], AbortSignal.timeout(5_000), {
        PATH: path,
      });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim());
      return result.stdout.trim();
    } catch {
      throw new Error(
        `${name} could not run: ${command}. Check the installation with ${command} --version.`,
      );
    }
  }
  const gitVersion = await readVersion(gitPath, "Git");
  const wtVersion = await readVersion(wtPath, "Worktrunk");
  const match = /^wt v(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(wtVersion);
  const parts = match?.slice(1, 4).map(Number);
  const old =
    parts &&
    parts.some(
      (part, i) =>
        part < minimumWorktrunk[i]! &&
        parts.slice(0, i).every((value, j) => value === minimumWorktrunk[j]),
    );
  if (!parts || old)
    throw new Error(
      `Worktrunk 0.80.0 or newer is required; found ${wtVersion || "unknown version"}.\nUpdate it with: brew upgrade worktrunk`,
    );
  return { sources, wtPath, gitVersion, wtVersion };
}

const repositories = (count: number) => `${count} ${count === 1 ? "repository" : "repositories"}`;

/** The doctor's lines: the repositories each source finds, then the distinct total. */
export async function doctorSources(
  sources: RepoSource[],
  options: Pick<CliOptions, "defaults" | "depth">,
): Promise<string> {
  const found = await findRepos(sources, options.depth);
  const section = (kind: RepoSource["kind"], title: string, none: string) => {
    const lines = found
      .filter(({ source }) => source.kind === kind)
      .map(({ source, repos }) => `  ${source.folder}  ${repositories(repos.length)}`);
    return lines.length ? `${title}:\n${lines.join("\n")}` : `${title}: ${none}`;
  };
  const all = new Set(found.flatMap(({ repos }) => repos));
  return [
    section(
      "scan",
      "Scan folders",
      `none of ${DEFAULT_SCAN_FOLDERS.map((folder) => `~/${folder}`).join(", ")} exists`,
    ),
    ...(options.defaults
      ? [section("agent", "Agent worktree folders", "none of the known ones exists")]
      : []),
    `Repositories found: ${all.size}`,
  ].join("\n");
}
