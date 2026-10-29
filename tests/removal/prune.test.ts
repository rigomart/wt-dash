import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandResult, repo } from "./helpers";
import { createActionService } from "../../src/core/removal/service";
import type { CommandRunner } from "../../src/core/types";

test("prune refuses to run when the dry-run record list changes", async () => {
  let checks = 0;
  let prunes = 0;
  const runner: CommandRunner = async (_command, args) => {
    if (args.includes("--dry-run"))
      return commandResult(++checks === 1 ? "prune old\n" : "prune other\n");
    if (args.includes("prune")) prunes++;
    return commandResult();
  };
  const actions = createActionService({
    wtPath: "/wt",
    runner,
    logPath: join(tmpdir(), "unused-action-log"),
  });
  const plan = await actions.preparePrune(repo);
  expect(plan.records).toEqual(["prune old"]);
  expect(actions.executePrune(plan)).rejects.toThrow("changed");
  expect(prunes).toBe(0);
});
