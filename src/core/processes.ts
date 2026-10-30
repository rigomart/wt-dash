import { readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import type { CommandRunner, RunningProcess } from "./types";

interface Found {
  pid: number;
  cwd: string;
}

/** `lsof` exits 1 when it can't read some processes, so its output counts either way. */
async function cwdsFromLsof(runner: CommandRunner, signal?: AbortSignal): Promise<Found[]> {
  const { stdout } = await runner("lsof", ["-w", "-d", "cwd", "-Fpn"], signal);
  const found: Found[] = [];
  let pid: number | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== null) found.push({ pid, cwd: line.slice(1) });
  }
  return found;
}

/** Many Linux systems have no `lsof`. */
async function cwdsFromProc(proc: string): Promise<Found[]> {
  const pids = (await readdir(proc)).filter((name) => /^\d+$/.test(name));
  const found = await Promise.all(
    pids.map((pid) =>
      readlink(join(proc, pid, "cwd")).then(
        (cwd) => ({ pid: Number(pid), cwd }),
        () => null,
      ),
    ),
  );
  return found.filter((entry) => entry !== null);
}

/** `pid ppid tty args` per process; a tty of `?`, `??` or `-` means no controlling terminal. */
async function describe(
  pids: number[],
  runner: CommandRunner,
  signal?: AbortSignal,
): Promise<Map<number, { ppid: number; interactive: boolean; command: string }>> {
  const { stdout } = await runner(
    "ps",
    ["-ww", "-o", "pid=,ppid=,tty=,args=", "-p", pids.join(",")],
    signal,
  );
  const described = new Map<number, { ppid: number; interactive: boolean; command: string }>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const tty = match[3]!;
    described.set(Number(match[1]), {
      ppid: Number(match[2]),
      interactive: !(tty.startsWith("?") || tty === "-"),
      command: withoutProgramFolder(match[4]!.trim()),
    });
  }
  return described;
}

async function portsFromLsof(
  pids: number[],
  runner: CommandRunner,
  signal?: AbortSignal,
): Promise<Map<number, number[]>> {
  const { stdout } = await runner(
    "lsof",
    ["-w", "-nP", "-a", "-p", pids.join(","), "-iTCP", "-sTCP:LISTEN", "-Fpn"],
    signal,
  );
  const ports = new Map<number, number[]>();
  let pid: number | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== null) {
      const port = Number(line.slice(line.lastIndexOf(":") + 1));
      if (Number.isInteger(port)) ports.set(pid, [...(ports.get(pid) ?? []), port]);
    }
  }
  return ports;
}

/** Listening sockets from `/proc/net/tcp{,6}`, matched to each process by the socket inodes its fds point at. */
async function portsFromProc(proc: string, pids: number[]): Promise<Map<number, number[]>> {
  const listening = new Map<string, number>();
  for (const table of ["tcp", "tcp6"]) {
    const text = await readFile(join(proc, "net", table), "utf8").catch(() => "");
    for (const line of text.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      // State 0A is LISTEN.
      if (fields[3] !== "0A" || !fields[1] || !fields[9]) continue;
      listening.set(fields[9], parseInt(fields[1].split(":")[1]!, 16));
    }
  }
  const ports = new Map<number, number[]>();
  if (!listening.size) return ports;
  await Promise.all(
    pids.map(async (pid) => {
      const fds = await readdir(join(proc, String(pid), "fd")).catch(() => []);
      const links = await Promise.all(
        fds.map((fd) => readlink(join(proc, String(pid), "fd", fd)).catch(() => "")),
      );
      const found = links
        .map((link) => /^socket:\[(\d+)\]$/.exec(link)?.[1])
        .flatMap((inode) => (inode && listening.has(inode) ? [listening.get(inode)!] : []));
      if (found.length) ports.set(pid, found);
    }),
  );
  return ports;
}

function withoutProgramFolder(command: string): string {
  return command.replace(/^\/\S*\//, "");
}

function innermostOwner(cwd: string, longestFirst: string[]): string | null {
  return longestFirst.find((path) => cwd === path || cwd.startsWith(path + "/")) ?? null;
}

export interface FindProcessesOptions {
  platform?: NodeJS.Platform;
  /** Where Linux's `/proc` is; tests point it at a fake one. */
  proc?: string;
  /** This process, which is left out with its children (the `lsof` and `ps` it runs, and its `git`). */
  self?: number;
  signal?: AbortSignal;
}

/**
 * The processes whose working directory is inside each of `paths`, keyed by path, from one pass over every
 * process. Paths with none are left out; a failed pass finds none.
 */
export async function findProcesses(
  paths: string[],
  runner: CommandRunner,
  options: FindProcessesOptions = {},
): Promise<Record<string, RunningProcess[]>> {
  const { platform = process.platform, proc = "/proc", self = process.pid, signal } = options;
  const linux = platform === "linux";
  const longestFirst = [...paths].sort((a, b) => b.length - a.length);
  try {
    const owned = new Map<number, string>();
    for (const { pid, cwd } of linux
      ? await cwdsFromProc(proc)
      : await cwdsFromLsof(runner, signal)) {
      const path = pid === self ? null : innermostOwner(cwd, longestFirst);
      if (path) owned.set(pid, path);
    }
    if (!owned.size) return {};
    const pids = [...owned.keys()].sort((a, b) => a - b);
    const [described, ports] = await Promise.all([
      describe(pids, runner, signal),
      linux ? portsFromProc(proc, pids) : portsFromLsof(pids, runner, signal),
    ]);
    const byPath: Record<string, RunningProcess[]> = {};
    for (const pid of pids) {
      const path = owned.get(pid)!;
      const info = described.get(pid);
      if (!info || info.ppid === self) continue;
      (byPath[path] ??= []).push({
        pid,
        command: info.command,
        interactive: info.interactive,
        ports: [...new Set(ports.get(pid) ?? [])].sort((a, b) => a - b),
      });
    }
    return byPath;
  } catch {
    return {};
  }
}
