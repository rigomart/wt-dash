import { expect, test } from "bun:test";
import type { RowPatch } from "../../src/core/scan/dashboard";
import type { WorktreeRow } from "../../src/core/types";
import {
  dialog,
  dialogRow,
  exists,
  inSandbox,
  lineWith,
  removals,
  rowOf,
  withApp,
  TEST_TIMEOUT,
} from "../support/app";
import { online } from "../support/fixture";

test(
  "a worktree squash-merged on GitHub shows Review while gh is asked, then Safe with its pull request",
  () =>
    inSandbox(async (sandbox) => {
      const alpha = await sandbox.repo("alpha", { github: true });
      const feature = await alpha.prMergedWorktree("feature");
      const pr = feature.github!.pullRequests[0]!;
      // gh answers after a pause, so the screen shows the row before GitHub settles it.
      await sandbox.gh.setMode("ok", 1500);
      await withApp(
        sandbox,
        { width: 120, name: "checked on GitHub", github: online(sandbox) },
        async (app) => {
          let frame = await app.waitFor(
            (text) =>
              lineWith(text, "wt-dash").includes("checking GitHub") &&
              rowOf(text, "feature") !== null,
          );
          expect(rowOf(frame, "feature")).toStartWith(
            "□ feature unmerged commits 1 commit isn't in main, and merging would conflict ",
          );
          frame = await app.waitFor(
            (text) => rowOf(text, "feature")?.includes("merged on GitHub") ?? false,
          );
          expect(rowOf(frame, "feature")).toStartWith(
            `□ feature merged on GitHub PR #${pr} merged `,
          );
          expect(rowOf(frame, "feature")).toContain(" with this exact commit ");
          frame = await app.waitFor((text) => !lineWith(text, "wt-dash").includes("checking"));
          expect(lineWith(frame, "Review 0")).toContain("Safe 1");
          expect(await sandbox.gh.calls()).toHaveLength(1);
        },
      );
    }),
  TEST_TIMEOUT,
);

test(
  "a worktree a follow-up proves merged on GitHub: the dialog names its PR, and removing it deletes the branch",
  () =>
    inSandbox(async (sandbox) => {
      const alpha = await sandbox.repo("alpha");
      const feature = await alpha.unmergedWorktree("feature");
      // As the GitHub check would answer: PR #60 merged the tip of feature.
      const followUp = async (_repo: string, rows: WorktreeRow[]): Promise<RowPatch[]> =>
        rows
          .filter((row) => row.branch === "feature")
          .map((row) => ({
            id: row.id,
            headSha: row.headSha!,
            facts: {
              forge: {
                kind: "proven",
                tip: row.headSha!,
                pr: 60,
                mergedAt: "2026-10-30T12:00:00Z",
                base: "main",
                by: "commit",
              },
            },
          }));
      await withApp(sandbox, { width: 120, name: "merged on GitHub", followUp }, async (app) => {
        await app.settled();
        let frame = await app.waitFor(
          (text) => rowOf(text, "feature")?.includes("merged on GitHub") ?? false,
        );
        expect(rowOf(frame, "feature")).toStartWith("□ feature merged on GitHub PR #60 merged ");

        await app.focus("feature");
        await app.press("x");
        frame = await app.waitFor("Remove 1 worktree");
        expect(dialogRow(frame, "feature")).toStartWith("• feature alpha ");
        expect(dialog(frame)).toContain("Deletes branch feature: merged on GitHub as PR #60");
        expect(dialog(frame)).not.toContain("unmerged branch");
        await app.press("y");
        frame = await app.waitFor(/✓ Removed 1 worktree · (freed|up to) .+/);
        await app.waitFor((text) => rowOf(text, "feature") === null);
        expect(await exists(feature.path!)).toBe(false);
        expect(await alpha.git("branch", "--list", "feature")).toBe("");
        expect(
          (await removals(sandbox)).map(({ branch, flags, branchOutcome, branchProof }) => ({
            branch,
            flags,
            branchOutcome,
            branchProof,
          })),
        ).toEqual([
          {
            branch: "feature",
            flags: ["-D", "--reap"],
            branchOutcome: "deleted",
            branchProof: { pr: 60 },
          },
        ]);
      });
    }),
  TEST_TIMEOUT,
);
