import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SCAN_FOLDERS, type CliOptions } from "./cli";
import { runCommand } from "./core/process";
import { findRepos, type RepoSource } from "./core/scan/discovery";
import { readSavedRepos } from "./core/scan/saved";
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

async function readableFolder(folder: string): Promise<{ path: string } | { problem: string }> {
  try {
    if (!(await stat(folder)).isDirectory()) return { problem: "Not a folder" };
    await access(folder, constants.R_OK | constants.X_OK);
    return { path: await realpath(folder) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { problem: "Scan folder not found" };
    if (code === "ELOOP") return { problem: "Scan folder is a symbolic link loop" };
    if (code === "EACCES" || code === "EPERM")
      return { problem: "Scan folder can't be read (permission denied)" };
    return { problem: "Scan folder can't be read" };
  }
}

async function repoSources(options: CliOptions, home: string): Promise<RepoSource[]> {
  const sources: RepoSource[] = [];
  const add = (source: RepoSource) => {
    if (!sources.some(({ folder }) => folder === source.folder)) sources.push(source);
  };
  for (const root of options.roots) {
    const folder = await readableFolder(root);
    if ("path" in folder) add({ kind: "scan", folder: folder.path });
    else if (!options.defaults)
      throw new Error(`${folder.problem}: ${root}\nSupply a folder, for example: wt-dash ~/code`);
  }
  if (options.defaults)
    for (const { folder: relative, levels } of AGENT_FOLDERS) {
      const folder = await readableFolder(join(home, relative));
      if ("path" in folder) add({ kind: "agent", folder: folder.path, levels });
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
      options.wtPath
        ? `Worktrunk was not found at ${options.wtPath}, given with --wt-path.\nSupply the path of the wt executable, or leave --wt-path out to look for it on PATH.`
        : "Worktrunk was not found. Install it with: brew install worktrunk, or cargo install worktrunk\nOr supply its executable with --wt-path /path/to/wt",
    );

  async function readVersion(command: string, name: string): Promise<string> {
    let detail = "";
    try {
      const result = await runCommand(command, ["--version"], AbortSignal.timeout(5_000), {
        PATH: path,
      });
      if (result.exitCode === 0) return result.stdout.trim();
      detail = result.stderr.trim().split("\n")[0] ?? "";
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
    throw new Error(
      `${name} could not run: ${command}${detail ? ` (${detail})` : ""}. Check the installation with ${command} --version.`,
    );
  }
  const gitVersion = await readVersion(gitPath, "Git");
  const wtVersion = await readVersion(wtPath, "Worktrunk");
  const parsed = worktrunkVersion(wtVersion);
  if (!parsed)
    throw new Error(
      `Could not read Worktrunk's version from ${wtPath} --version, which printed: ${wtVersion || "nothing"}\nwt-dash needs Worktrunk 0.80.0 or newer. Install a release with: brew install worktrunk, or cargo install worktrunk`,
    );
  const parts = parsed.release;
  const old =
    parts.some(
      (part, i) =>
        part < minimumWorktrunk[i]! &&
        parts.slice(0, i).every((value, j) => value === minimumWorktrunk[j]),
    ) ||
    (parsed.prerelease && parts.every((part, i) => part === minimumWorktrunk[i]));
  if (old)
    throw new Error(
      `Worktrunk 0.80.0 or newer is required; found ${wtVersion} at ${wtPath}.\nUpdate it with: brew upgrade worktrunk, or cargo install worktrunk`,
    );
  return { sources, wtPath, gitVersion, wtVersion };
}

/**
 * The release in `wt --version`: `wt v0.80.0` from a Homebrew bottle or a tagged build, `wt 0.80.0` from
 * crates.io, `wt v0.80.0-3-gabc1234` or `-dirty` from a build past a tag. Any other `-` suffix is a
 * pre-release, which comes before its release.
 */
export function worktrunkVersion(
  output: string,
): { release: number[]; prerelease: boolean } | null {
  const match = /^wt v?(\d+)\.(\d+)\.(\d+)([-+]\S*)?(?:\s|$)/.exec(output);
  if (!match) return null;
  const suffix = match[4] ?? "";
  return {
    release: match.slice(1, 4).map(Number),
    prerelease: suffix.startsWith("-") && !/^-(\d+-g[0-9a-f]+|dirty)\b/.test(suffix),
  };
}

const repositories = (count: number) => `${count} ${count === 1 ? "repository" : "repositories"}`;

/**
 * The doctor's lines: the repositories each source finds, then the distinct total. Without folders, the repositories
 * saved in `savedFile` are a source too.
 */
export async function doctorSources(
  sources: RepoSource[],
  options: Pick<CliOptions, "defaults" | "depth">,
  savedFile?: string,
): Promise<string> {
  const found = await findRepos(sources, options.depth);
  const saved = options.defaults && savedFile ? await readSavedRepos(savedFile) : null;
  const section = (kind: RepoSource["kind"], title: string, none: string) => {
    const lines = found
      .filter(({ source }) => source.kind === kind)
      .map(({ source, repos }) => `  ${source.folder}  ${repositories(repos.length)}`);
    return lines.length ? `${title}:\n${lines.join("\n")}` : `${title}: ${none}`;
  };
  const all = new Set([...found.flatMap(({ repos }) => repos), ...(saved ?? [])]);
  return [
    section(
      "scan",
      "Scan folders",
      `none of ${DEFAULT_SCAN_FOLDERS.map((folder) => `~/${folder}`).join(", ")} exists`,
    ),
    ...(options.defaults
      ? [section("agent", "Agent worktree folders", "none of the known ones exists")]
      : []),
    ...(saved ? [`Saved repositories:\n  ${savedFile}  ${repositories(saved.length)}`] : []),
    `Repositories found: ${all.size}`,
  ].join("\n");
}
