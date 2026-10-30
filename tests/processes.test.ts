import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProcesses } from "../src/core/processes";
import type { CommandResult, CommandRunner } from "../src/core/types";

const SELF = 900;
const WT = "/work/app.feature";
const NESTED = "/work/app.feature/.claude/worktrees/inner";

function runner(outputs: Record<string, string>, calls: string[][] = []): CommandRunner {
  return async (command, args): Promise<CommandResult> => {
    calls.push([command, ...args]);
    const key = command === "lsof" && args.includes("cwd") ? "cwd" : command;
    if (outputs[key] === undefined) throw new Error(`unexpected ${command}`);
    // lsof exits 1 when it can't read some processes; its output still counts.
    return { stdout: outputs[key]!, stderr: "", exitCode: command === "lsof" ? 1 : 0 };
  };
}

test("on macOS, finds processes by working directory, the deepest worktree first, with their ports", async () => {
  const calls: string[][] = [];
  const found = await findProcesses(
    [WT, NESTED, "/work/app.other"],
    runner(
      {
        cwd: [
          "p1",
          "n/",
          "p101",
          `n${WT}`,
          "p102",
          `n${WT}/src`,
          "p103",
          `n${NESTED}`,
          "p104",
          `n${WT}-copy`,
          `p${SELF}`,
          `n${WT}`,
          "p901",
          `n${WT}`,
          "p105",
          `n${WT}`,
        ].join("\n"),
        ps: [
          "  101     1 ??       /opt/homebrew/bin/node /work/app.feature/node_modules/.bin/vite",
          "  102   777 ttys003  -zsh",
          "  103     1 ??       bun --watch src/index.ts",
          `  901   ${SELF} ??       /usr/sbin/lsof -d cwd`,
        ].join("\n"),
        lsof: ["p101", "f20", "n*:5173", "f21", "n[::1]:5173", "f22", "n127.0.0.1:24678"].join(
          "\n",
        ),
      },
      calls,
    ),
    { platform: "darwin", self: SELF },
  );
  expect(found).toEqual({
    [WT]: [
      {
        pid: 101,
        command: "node /work/app.feature/node_modules/.bin/vite",
        interactive: false,
        ports: [5173, 24678],
      },
      { pid: 102, command: "-zsh", interactive: true, ports: [] },
    ],
    [NESTED]: [{ pid: 103, command: "bun --watch src/index.ts", interactive: false, ports: [] }],
  });
  // 105 had exited by the ps pass.
  expect(calls).toEqual([
    ["lsof", "-w", "-d", "cwd", "-Fpn"],
    ["ps", "-ww", "-o", "pid=,ppid=,tty=,args=", "-p", "101,102,103,105,901"],
    ["lsof", "-w", "-nP", "-a", "-p", "101,102,103,105,901", "-iTCP", "-sTCP:LISTEN", "-Fpn"],
  ]);
});

test("runs nothing more when no process is inside a worktree", async () => {
  const calls: string[][] = [];
  const found = await findProcesses([WT], runner({ cwd: "p1\nn/" }, calls), {
    platform: "darwin",
  });
  expect(found).toEqual({});
  expect(calls).toHaveLength(1);
});

test("finds nothing when a command fails", async () => {
  const failing: CommandRunner = async () => {
    throw new Error("lsof: not found");
  };
  expect(await findProcesses([WT], failing, { platform: "darwin" })).toEqual({});
});

let proc: string;
let worktree: string;

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "wt-dash-proc-"));
  proc = join(root, "proc");
  worktree = join(root, "wt");
  await mkdir(join(worktree, "src"), { recursive: true });
  const process = async (pid: number, cwd: string, fds: Record<string, string> = {}) => {
    await mkdir(join(proc, String(pid), "fd"), { recursive: true });
    await symlink(cwd, join(proc, String(pid), "cwd"));
    for (const [fd, target] of Object.entries(fds))
      await symlink(target, join(proc, String(pid), "fd", fd));
  };
  await process(1, "/");
  await process(201, worktree, { "0": "/dev/null", "3": "socket:[5001]", "4": "socket:[5002]" });
  await process(202, join(worktree, "src"), { "5": "socket:[5003]" });
  // Another user's process: its cwd can't be read.
  await mkdir(join(proc, "203"), { recursive: true });
  await mkdir(join(proc, "net"), { recursive: true });
  const header =
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
  await writeFile(
    join(proc, "net", "tcp"),
    [
      header,
      // 127.0.0.1:3000, listening.
      "   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5001 1 0 100 0 0 10 0",
      // An established connection, not a listener.
      "   1: 0100007F:D431 0100007F:0BB8 01 00000000:00000000 00:00000000 00000000  1000        0 5003 1 0 20 4 30 10 -1",
    ].join("\n"),
  );
  await writeFile(
    join(proc, "net", "tcp6"),
    [
      header,
      // [::]:5173, listening.
      "   0: 00000000000000000000000000000000:1435 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5002 1 0 100 0 0 10 0",
    ].join("\n"),
  );
});

afterAll(() => rm(join(proc, ".."), { recursive: true, force: true }));

test("on Linux, reads working directories and listening ports from /proc", async () => {
  const calls: string[][] = [];
  const found = await findProcesses(
    [worktree],
    runner(
      {
        ps: ["  201     1 ?        node server.js", "  202     1 pts/1    vim src/a.ts"].join("\n"),
      },
      calls,
    ),
    { platform: "linux", proc, self: SELF },
  );
  expect(found).toEqual({
    [worktree]: [
      { pid: 201, command: "node server.js", interactive: false, ports: [3000, 5173] },
      { pid: 202, command: "vim src/a.ts", interactive: true, ports: [] },
    ],
  });
  expect(calls).toEqual([["ps", "-ww", "-o", "pid=,ppid=,tty=,args=", "-p", "201,202"]]);
});
