import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  dialogRow,
  exists,
  inSandbox,
  removals,
  rowOf,
  sectionOf,
  TEST_TIMEOUT,
} from "../support/app";

const [WIDTH, HEIGHT] = [100, 30];
const ENTRY = join(import.meta.dir, "../../src/index.ts");

/** Runs argv[3:] in a pseudo-terminal of argv[1] columns and argv[2] rows, relaying stdout and stdin; closing stdin kills the app. Bun has no PTY API. */
const RELAY = `
import fcntl, os, pty, select, struct, subprocess, sys, termios
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", int(sys.argv[2]), int(sys.argv[1]), 0, 0))
child = subprocess.Popen(sys.argv[3:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
inputs = [master, 0]
while master in inputs:
    for fd in select.select(inputs, [], [])[0]:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b""
        if fd == master and data:
            os.write(1, data)
        elif fd == master:
            inputs.remove(master)
        elif data:
            os.write(master, data)
        else:
            inputs.remove(0)
            child.kill()
sys.exit(child.wait())
`;

/** OpenTUI redraws only the cells that changed, placing each run with a cursor move, so the raw output alone doesn't read as the screen. */
function terminal(width: number, height: number) {
  const cells = Array.from({ length: height }, () => Array<string>(width).fill(" "));
  const decoder = new TextDecoder();
  // oxlint-disable-next-line no-control-regex -- parsing terminal output
  const control = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|[\]P_^X][\s\S]*?(?:\x07|\x1b\\)|[^\]P_^X[])/;
  let [row, column, pending] = [0, 0, ""];
  return {
    write(bytes: Uint8Array) {
      const text = pending + decoder.decode(bytes, { stream: true });
      pending = "";
      for (let at = 0; at < text.length;) {
        if (text[at] === "\x1b") {
          const match = control.exec(text.slice(at));
          if (!match) {
            pending = text.slice(at);
            break;
          }
          // oxlint-disable-next-line no-control-regex -- parsing terminal output
          const move = /^\x1b\[(\d*)(?:;(\d*))?H$/.exec(match[0]);
          if (move) [row, column] = [Number(move[1] || 1) - 1, Number(move[2] || 1) - 1];
          at += match[0].length;
          continue;
        }
        const char = String.fromCodePoint(text.codePointAt(at)!);
        at += char.length;
        const width = Bun.stringWidth(char);
        if (char === "\r") column = 0;
        else if (char === "\n") row++;
        else if (char < " ") continue;
        else if (width === 0 && column > 0 && cells[row]) cells[row]![column - 1] += char;
        else {
          if (cells[row] && column < cells[row]!.length) cells[row]![column] = char;
          if (width === 2 && cells[row] && column + 1 < cells[row]!.length)
            cells[row]![column + 1] = "";
          column += width;
        }
      }
    },
    text: () => cells.map((line) => line.join("").trimEnd()).join("\n"),
  };
}

test(
  "the binary's own wiring removes a Safe worktree with --reap, keeps the Review one, and quits with 0",
  () =>
    inSandbox(async (sandbox) => {
      const repo = await sandbox.repo("alpha");
      const squashed = await repo.squashMergedWorktree("squashed");
      const fresh = await repo.freshWorktree("fresh");
      const app = Bun.spawn(
        [
          "python3",
          "-I",
          "-c",
          RELAY,
          `${WIDTH}`,
          `${HEIGHT}`,
          process.execPath,
          ENTRY,
          sandbox.scanRoot,
        ],
        {
          cwd: sandbox.root,
          env: { ...sandbox.env, TERM: "xterm-256color" },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "inherit",
        },
      );
      const screen = terminal(WIDTH, HEIGHT);
      const waiters = new Set<() => void>();
      const reading = (async () => {
        for await (const chunk of app.stdout) {
          screen.write(chunk);
          for (const check of waiters) check();
        }
      })();
      let exited = false;
      void app.exited.then(() => {
        exited = true;
        for (const check of waiters) check();
      });

      function waitFor(match: (text: string) => boolean, what: string, timeout = 10_000) {
        return new Promise<string>((resolve, reject) => {
          const fail = (why: string) => {
            done();
            reject(new Error(`${why} waiting for ${what}. Screen:\n${screen.text()}`));
          };
          const check = () => {
            if (match(screen.text())) {
              done();
              resolve(screen.text());
            } else if (exited) fail(`The app exited with ${app.exitCode}`);
          };
          const timer = setTimeout(() => fail(`Timed out after ${timeout} ms`), timeout);
          const done = () => {
            clearTimeout(timer);
            waiters.delete(check);
          };
          waiters.add(check);
          check();
        });
      }
      const press = (key: string) => {
        app.stdin.write(key);
        app.stdin.flush();
      };

      try {
        let text = await waitFor(
          (shown) => shown.includes("scanned ") && shown.includes("? REVIEW  1 worktree"),
          "the scanned list",
        );
        expect(sectionOf(text, "squashed")).toBe("SAFE");
        expect(sectionOf(text, "fresh")).toBe("REVIEW");
        expect(rowOf(text, "squashed")).toStartWith(
          "□ squashed merged Merging it into main would change nothing now ",
        );
        press("a");
        text = await waitFor(
          (shown) => rowOf(shown, "squashed")?.startsWith("■ ") ?? false,
          "squashed selected",
        );
        expect(rowOf(text, "fresh")).toStartWith("□ fresh ");
        press("x");
        text = await waitFor((shown) => shown.includes("╭─ Remove 1 worktree"), "the dialog");
        expect(dialogRow(text, "squashed")).toStartWith("• squashed alpha ");
        expect(dialogRow(text, "fresh")).toBe("");
        press("y");
        await waitFor((shown) => shown.includes("✓ Removed 1 worktree · "), "the removal toast");

        expect(await exists(squashed.path!)).toBe(false);
        expect(await exists(fresh.path!)).toBe(true);
        expect(
          (await removals(sandbox)).map(({ branch, path, flags, exitCode }) => ({
            branch,
            path,
            flags,
            exitCode,
          })),
        ).toEqual([{ branch: "squashed", path: squashed.path, flags: ["--reap"], exitCode: 0 }]);
        expect(await exists(join(sandbox.home, ".cache", "wt-dash", "sizes.json"))).toBe(true);

        press("q");
        expect(await app.exited).toBe(0);
      } finally {
        if (!exited) {
          app.stdin.end();
          const timer = setTimeout(() => app.kill("SIGKILL"), 5000);
          await app.exited;
          clearTimeout(timer);
        }
        await reading;
      }
    }),
  TEST_TIMEOUT,
);
