import { join, resolve } from "node:path";
import metadata from "../package.json";

export const version = metadata.version;
export const help = `wt-dash ${version} — inspect and clean up Git worktrees on macOS

Usage: wt-dash [options] [folder ...]

Scan ~/projects by default, or supply one or more repositories or parent folders.

Options:
  --depth <number>    Folder levels to search below each root (0–20; default: 2)
  --wt-path <path>    Use a specific Worktrunk executable
  --doctor           Check scan folders, Git, and Worktrunk without opening the UI
  -h, --help         Show this help
  -v, --version      Show the version
  --                 Treat remaining arguments as folder names

Examples:
  wt-dash ~/projects ~/work
  wt-dash . --depth 0
  wt-dash --doctor ~/code
`;

export interface CliOptions {
  mode: "run" | "help" | "version" | "doctor";
  roots: string[];
  depth: number;
  wtPath?: string;
}

export function expandPath(path: string, home: string, cwd: string): string {
  if (path === "~") return home;
  return resolve(cwd, path.startsWith("~/") ? join(home, path.slice(2)) : path);
}

export function parseArgs(args: string[], home: string, cwd: string): CliOptions {
  const options: CliOptions = { mode: "run", roots: [], depth: 2 };
  let positional = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!positional && arg === "--") { positional = true; continue; }
    if (!positional && (arg === "--help" || arg === "-h")) { options.mode = "help"; continue; }
    if (!positional && (arg === "--version" || arg === "-v")) { options.mode = "version"; continue; }
    if (!positional && arg === "--doctor") { options.mode = "doctor"; continue; }
    if (!positional && (arg === "--depth" || arg === "--wt-path")) {
      const value = args[++index];
      if (!value || value.startsWith("-")) throw new Error(`${arg} requires a value. Run wt-dash --help.`);
      if (arg === "--depth") {
        if (!/^\d+$/.test(value) || Number(value) > 20) throw new Error("--depth must be a whole number from 0 to 20.");
        options.depth = Number(value);
      } else options.wtPath = expandPath(value, home, cwd);
      continue;
    }
    if (!positional && arg.startsWith("-")) throw new Error(`Unknown option: ${arg}. Run wt-dash --help.`);
    options.roots.push(expandPath(arg, home, cwd));
  }
  if (!options.roots.length) options.roots.push(join(home, "projects"));
  return options;
}
