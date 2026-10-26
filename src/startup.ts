import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import type { CliOptions } from "./cli";
import { runCommand } from "./core/process";

const minimumWorktrunk = [0, 80, 0];

async function executable(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile() && await access(path, constants.X_OK).then(() => true);
  } catch { return false; }
}

export async function prepareStartup(options: CliOptions, environment: { platform?: string; path?: string } = {}) {
  if ((environment.platform ?? process.platform) !== "darwin") throw new Error("This release supports macOS only.");
  const roots: string[] = [];
  for (const root of options.roots) {
    try {
      if (!(await stat(root)).isDirectory()) throw new Error("not a directory");
      await access(root, constants.R_OK | constants.X_OK);
      roots.push(await realpath(root));
    } catch {
      throw new Error(`Scan folder is missing or unreadable: ${root}\nSupply a folder, for example: wt-dash ~/code`);
    }
  }

  const path = environment.path ?? process.env.PATH ?? "";
  const gitPath = Bun.which("git", { PATH: path });
  if (!gitPath) throw new Error("Git was not found on PATH. Install Apple's command line tools: xcode-select --install");
  const candidates = options.wtPath ? [options.wtPath] : [
    Bun.which("wt", { PATH: path }), "/opt/homebrew/bin/wt", "/usr/local/bin/wt",
  ].filter((candidate): candidate is string => candidate !== null);
  let wtPath: string | undefined;
  for (const candidate of candidates) {
    if (await executable(candidate)) { wtPath = candidate; break; }
  }
  if (!wtPath) throw new Error("Worktrunk was not found. Install it with: brew install worktrunk\nOr supply its executable with --wt-path /path/to/wt");

  async function readVersion(command: string, name: string): Promise<string> {
    try {
      const result = await runCommand(command, ["--version"], AbortSignal.timeout(5_000), { PATH: path });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim());
      return result.stdout.trim();
    } catch {
      throw new Error(`${name} could not run: ${command}. Check the installation with ${command} --version.`);
    }
  }
  const gitVersion = await readVersion(gitPath, "Git");
  const wtVersion = await readVersion(wtPath, "Worktrunk");
  const match = /^wt v(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(wtVersion);
  const parts = match?.slice(1, 4).map(Number);
  const old = parts && parts.some((part, i) => part < minimumWorktrunk[i]! && parts.slice(0, i).every((value, j) => value === minimumWorktrunk[j]));
  if (!parts || old) throw new Error(`Worktrunk 0.80.0 or newer is required; found ${wtVersion || "unknown version"}.\nUpdate it with: brew upgrade worktrunk`);
  return { roots: [...new Set(roots)], wtPath, gitVersion, wtVersion };
}
