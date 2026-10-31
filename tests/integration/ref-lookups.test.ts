import { expect, test } from "bun:test";
import type { CommandRunner } from "../../src/core/types";
import { createSandbox, TEST_TIMEOUT } from "../support/fixture";
import { exists, row, scan } from "./helpers";

test.each(["unchecked", "unconfirmed unmerged"])(
  "removal snapshots omit %s references while keeping their branches",
  async (kind) => {
    const sandbox = await createSandbox();
    try {
      const repo = await sandbox.repo("ref-lookups");
      const chosen = await repo.squashMergedWorktree("chosen");
      const unchecked = Array.from({ length: 12 }, (_, index) => `keep-${index}`);
      if (kind === "unconfirmed unmerged") await repo.unmergedBranch(unchecked[0]!);
      for (const branch of unchecked.slice(kind === "unchecked" ? 0 : 1))
        await repo.git("branch", branch, kind === "unchecked" ? "main" : unchecked[0]!);
      const lookedUp: string[] = [];
      let executing = false;
      const runner: CommandRunner = async (command, args, signal) => {
        if (executing && command === "git" && args.includes("--verify") && args.includes("-q"))
          lookedUp.push(args.at(-1)!);
        return sandbox.runner(command, args, signal);
      };
      const { dashboard, actions } = await sandbox.services({ runner });
      const snapshot = await scan(dashboard, repo);
      const selected = row(snapshot, chosen);
      const excluded = snapshot.rows.filter((entry) => unchecked.includes(entry.branch ?? ""));
      expect(excluded).toHaveLength(12);
      const plan = await actions.prepareRemoval([selected, ...excluded]);
      expect(plan.entries.every((entry) => entry.blockedReason === null)).toBe(true);
      executing = true;
      const choices = Object.fromEntries(
        [selected, ...excluded].map((entry) => [
          entry.id,
          { include: entry === selected || kind !== "unchecked" },
        ]),
      );
      const result = await actions.executeRemoval(plan, choices);
      expect(result.items[0]).toEqual({
        id: selected.id,
        status: "removed",
        branchOutcome: "deleted",
      });
      expect(result.items.slice(1).every((item) => item.status === "skipped")).toBe(true);
      expect(
        lookedUp.filter((ref) => unchecked.some((branch) => ref === `${branch}@{upstream}`)),
      ).toEqual([]);
      expect(await exists(chosen.path!)).toBe(false);
      expect((await repo.git("branch", "--format=%(refname:short)")).split("\n").sort()).toEqual(
        [...unchecked, "main"].sort(),
      );
    } finally {
      await sandbox.cleanup();
    }
  },
  TEST_TIMEOUT,
);
