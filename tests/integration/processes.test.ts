import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { createSandbox, type Sandbox, TEST_TIMEOUT } from "../support/fixture";
import { startServer, type Server } from "../support/server";
import { row, scan } from "./helpers";

setDefaultTimeout(TEST_TIMEOUT);

let sandbox: Sandbox;
const servers: Server[] = [];

beforeAll(async () => {
  sandbox = await createSandbox();
}, 30_000);

afterAll(async () => {
  await Promise.all(servers.map((server) => server.stop()));
  await sandbox?.cleanup();
});

test("a scan finds the server running in a worktree and the port it listens on (#44)", async () => {
  const repo = await sandbox.repo("served");
  const serving = await repo.mergedWorktree("serving");
  const idle = await repo.mergedWorktree("idle");
  const server = await startServer(serving.path!);
  servers.push(server);
  const { dashboard } = await sandbox.services();

  const snapshot = await scan(dashboard, repo);

  expect(snapshot.processes[row(snapshot, serving).path!]).toEqual([
    {
      pid: server.pid,
      command: expect.stringContaining(" -e "),
      interactive: false,
      ports: [server.port],
    },
  ]);
  expect(snapshot.processes[row(snapshot, idle).path!]).toBeUndefined();
  expect(row(snapshot, serving).verdict, "processes do not change the verdict").toBe("Safe");
});

test("removing a worktree with processes stopped frees its port, and the next scan finds nothing (#44)", async () => {
  const repo = await sandbox.repo("reaped");
  const serving = await repo.mergedWorktree("serving");
  const server = await startServer(serving.path!);
  servers.push(server);
  const { dashboard, actions } = await sandbox.services();
  let snapshot = await scan(dashboard, repo);
  expect(snapshot.processes[serving.path!]?.map((found) => found.pid)).toEqual([server.pid]);

  const shown = row(snapshot, serving);
  const plan = await actions.prepareRemoval([shown]);
  const result = await actions.executeRemoval(plan, {
    [shown.id]: { include: true, reapProcesses: true },
  });
  expect(result.items.map((item) => item.status)).toEqual(["removed"]);

  const deadline = Date.now() + 5000;
  while (server.alive() && Date.now() < deadline) await Bun.sleep(50);
  expect(server.alive()).toBe(false);
  snapshot = await scan(dashboard, repo);
  expect(snapshot.processes[serving.path!]).toBeUndefined();
});
