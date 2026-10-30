import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Server {
  pid: number;
  port: number;
  alive(): boolean;
  stop(): Promise<void>;
}

/**
 * Starts an HTTP server whose working directory is `cwd`, the way a dev server left behind by an agent runs:
 * in its own session with no controlling terminal, and not a child of the test.
 */
export async function startServer(cwd: string): Promise<Server> {
  const portFile = join(tmpdir(), `wt-dash-server-${process.pid}-${Date.now()}.txt`);
  const script = `const s = Bun.serve({ port: 0, fetch: () => new Response("") }); console.log(s.port);`;
  const shell = Bun.spawn(
    ["/bin/sh", "-c", `"$0" -e '${script}' > "$1" 2>&1 & echo $!`, process.execPath, portFile],
    { cwd, detached: true, stdout: "pipe" },
  );
  const pid = Number((await new Response(shell.stdout).text()).trim());
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + 10_000;
  let port = NaN;
  while (!Number.isInteger(port) || port <= 0) {
    if (Date.now() > deadline) {
      if (alive()) process.kill(pid);
      throw new Error(`server in ${cwd} did not start`);
    }
    await Bun.sleep(20);
    port = Number((await readFile(portFile, "utf8").catch(() => "")).trim() || NaN);
  }
  return {
    pid,
    port,
    alive,
    async stop() {
      if (alive()) process.kill(pid);
      await rm(portFile, { force: true });
    },
  };
}
