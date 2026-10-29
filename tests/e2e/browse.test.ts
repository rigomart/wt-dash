import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { sizeLabel } from "../../src/ui/format";
import {
  exists,
  focusedRow,
  lineWith,
  listPart,
  rowOf,
  sectionOf,
  squeeze,
  withApp,
  type App,
  TEST_TIMEOUT,
} from "../support/app";
import { createSandbox, type Built, type Sandbox } from "../support/fixture";

const WIDTHS = [120, 80] as const;

let sandbox: Sandbox;
let alpha: Record<string, Built>;
let beta: Built;

beforeAll(async () => {
  sandbox = await createSandbox();
  const repo = await sandbox.repo("alpha");
  const other = await sandbox.repo("beta");
  const [built, done] = await Promise.all([
    (async () => {
      const rows: Record<string, Built> = {};
      rows.squashed = await repo.squashMergedWorktree("squashed");
      rows.merged = await repo.mergedWorktree("merged");
      rows.leftover = await repo.mergedBranch("leftover");
      rows.fresh = await repo.freshWorktree("fresh");
      rows.locked = await repo.lockedWorktree("locked");
      rows.rebasing = await repo.rebasingWorktree("rebasing");
      rows.gone = await repo.deletedWorktree("gone");
      rows.open = await repo.unmergedBranch("open");
      return rows;
    })(),
    other.squashMergedWorktree("done"),
  ]);
  alpha = built;
  beta = done;
}, 30_000);

afterAll(() => sandbox?.cleanup());

/** What the list's reason column shows: a lock's own reason, else the reason without its full stop. */
const shownReason = (built: Built) =>
  built.expected.status === "locked"
    ? built.expected.reason.replace(/^Locked: /, "")
    : built.expected.reason.replace(/\.$/, "");

/** The AGE column counts from the row's last commit, not from when the worktree was made. */
const AGES: Record<string, string> = {
  squashed: "now",
  merged: "3d",
  leftover: "3d",
  fresh: "3d",
  locked: "3d",
  rebasing: "now",
  open: "3d",
};

function expectRow(
  app: App,
  frame: string,
  built: Built,
  mark = built.expected.blocked ? "–" : "□",
) {
  const text = rowOf(frame, built.branch);
  const size = built.kind === "branch" ? "branch" : app.size(built);
  const parsed = new RegExp(
    `^(.) ${built.branch} ${built.expected.status} (.+?) ${AGES[built.branch]} ${size.replace(".", "\\.")}$`,
  ).exec(text ?? "");
  expect({ row: built.branch, text, parsed: parsed !== null }).toEqual({
    row: built.branch,
    text,
    parsed: true,
  });
  expect(parsed![1]).toBe(mark);
  expect(sectionOf(frame, built.branch)).toBe(built.expected.verdict.toUpperCase());
  const reason = shownReason(built);
  const visible = parsed![2]!;
  if (visible.endsWith("…")) {
    expect(visible.length).toBeGreaterThanOrEqual(12);
    expect(reason.startsWith(visible.slice(0, -1).trimEnd())).toBe(true);
  } else expect(visible).toBe(reason);
}

/** The projects screen line for `name`: the sidebar entry at ≥100 columns, else the table row. */
function projectRow(frame: string, name: string, width: number): string {
  const line = lineWith(frame, new RegExp(`^(▌ | {2})${name} `));
  return squeeze(width >= 100 ? line.slice(0, line.indexOf("│")) : line).trim();
}

for (const width of WIDTHS) {
  test(
    `at ${width} columns: projects with counts, then a project's rows with verdicts, reasons and sizes`,
    () =>
      withApp(sandbox, { width, name: "browse projects" }, async (app) => {
        let frame = await app.settled();
        const kib = (built: Built) => app.services.sizes.get(built.path!)!.sizeKiB;
        const alphaSafe = kib(alpha.squashed!) + kib(alpha.merged!);
        const alphaTotal = ["squashed", "merged", "fresh", "locked", "rebasing"].reduce(
          (sum, name) => sum + kib(alpha[name]!),
          0,
        );
        const betaKiB = kib(beta);
        if (width >= 100) {
          expect(projectRow(frame, "All projects", width)).toBe(
            `All projects 7 ${sizeLabel(alphaSafe + betaKiB)}`,
          );
          expect(projectRow(frame, "alpha", width)).toBe(`▌ alpha 6 ${sizeLabel(alphaSafe)}`);
          expect(projectRow(frame, "beta", width)).toBe(`beta 1 ${sizeLabel(betaKiB)}`);
          expect(frame).toContain(`${sizeLabel(alphaSafe)} safe of ${sizeLabel(alphaTotal)}`);
          expect(frame).toContain("→ worktrees  a select safe  / search");
        } else {
          expect(squeeze(lineWith(frame, "PROJECT")).trim()).toBe(
            "PROJECT WORKTREES SAFE REVIEW BUSY BROKEN SAFE SIZE TOTAL",
          );
          expect(projectRow(frame, "All projects", width)).toBe(
            `All projects 7 4 3 1 1 ${sizeLabel(alphaSafe + betaKiB)} ${sizeLabel(alphaTotal + betaKiB)}`,
          );
          expect(projectRow(frame, "alpha", width)).toBe(
            `▌ alpha 6 3 3 1 1 ${sizeLabel(alphaSafe)} ${sizeLabel(alphaTotal)}`,
          );
          expect(projectRow(frame, "beta", width)).toBe(
            `beta 1 1 · · · ${sizeLabel(betaKiB)} ${sizeLabel(betaKiB)}`,
          );
          expect(frame).toContain(
            `SAFE TO FREE  ${sizeLabel(alphaSafe)} of ${sizeLabel(alphaTotal)}`,
          );
          expect(frame).toContain("enter open  a select safe  / search");
          expect(rowOf(frame, "squashed")).toBeNull();
        }

        await app.press(width >= 100 ? "right" : "enter");
        frame = await app.waitFor("space select  enter remove");
        expect(squeeze(lineWith(frame, "wt-dash"))).toStartWith(
          `wt-dash › alpha ${width >= 100 ? "6 worktrees and 2 branches · " : ""}up to ${sizeLabel(alphaTotal)} · `,
        );
        expect(squeeze(lineWith(frame, "All 8"))).toContain(
          "All 8 Safe 3 Review 3 Busy 1 Broken 1 / search",
        );
        for (const built of Object.values(alpha)) {
          if (built.expected.verdict === "Broken") continue;
          expectRow(app, frame, built);
        }
        expect(rowOf(frame, "done")).toBeNull();
        expect(rowOf(frame, "gone")).toMatch(/^– gone folder missing .+ …$/);
        expect(sectionOf(frame, "gone")).toBe("BROKEN");
        expect(focusedRow(frame)).not.toBeNull();
      }),
    TEST_TIMEOUT,
  );

  test(
    `at ${width} columns: tabs 1–5 filter by verdict, / narrows rows, i shows details, Esc steps back`,
    () =>
      withApp(sandbox, { width, name: "browse filters" }, async (app) => {
        await app.settled();
        await app.press(width >= 100 ? "right" : "enter");
        let frame = await app.waitFor("space select  enter remove");
        const names = (text: string) =>
          Object.values(alpha)
            .filter((built) => rowOf(text, built.branch) !== null)
            .map((built) => built.branch)
            .sort();
        expect(names(frame)).toEqual(
          Object.values(alpha)
            .map((built) => built.branch)
            .sort(),
        );

        const byVerdict = (verdict: string) =>
          Object.values(alpha)
            .filter((built) => built.expected.verdict === verdict)
            .map((built) => built.branch)
            .sort();
        for (const [key, verdict] of [
          ["2", "Safe"],
          ["3", "Review"],
          ["4", "Busy"],
          ["5", "Broken"],
        ] as const) {
          await app.press(key);
          frame = await app.waitFor((text) => names(text).join() === byVerdict(verdict).join());
          expect(sectionOf(frame, byVerdict(verdict)[0]!)).toBe(verdict.toUpperCase());
        }
        await app.press("1");
        frame = await app.waitFor((text) => names(text).length === 8);

        await app.press("/");
        await app.type("squash");
        frame = await app.waitFor((text) => names(text).join() === "squashed");
        expect(squeeze(listPart(lineWith(frame, "All 1"))).trim()).toBe(
          "All 1 Safe 1 Review 0 Busy 0 Broken 0 / squash 1 of 9",
        );
        await app.press("enter");
        frame = await app.waitFor("esc clears");
        expect(names(frame)).toEqual(["squashed"]);
        await app.press("3");
        frame = await app.waitFor("No Review worktrees match “squash”. Press 1 to see all.");
        await app.press("1");
        await app.press("escape");
        frame = await app.waitFor((text) => names(text).length === 8);
        expect(frame).not.toContain("esc clears");

        await app.focus("squashed");
        await app.press("i");
        frame = await app.waitFor("↑↓ scroll  i back");
        expect(frame).toContain("alpha / squashed");
        expect(frame).toContain("● Safe · merged");
        expect(frame).toContain(alpha.squashed!.expected.reason);
        expect(squeeze(frame)).toContain(`SIZE ${app.size(alpha.squashed!)} · measured just now`);
        await app.waitFor("UNCOMMITTED   none");
        await app.press("escape");
        frame = await app.waitFor((text) => !text.includes("i back"));
        expect(names(frame).length).toBe(8);
        expect(focusedRow(frame)).toStartWith("□ squashed ");
        await app.press("3");
        frame = await app.waitFor((text) => names(text).join() === byVerdict("Review").join());
        await app.press("escape");
        frame = await app.waitFor((text) => names(text).length === 8);
        await app.press("escape");
        frame = await app.waitFor(width >= 100 ? "→ worktrees" : "enter open");
        if (width < 100) expect(rowOf(frame, "squashed")).toBeNull();
        expect(focusedRow(frame)).toBeNull();
      }),
    TEST_TIMEOUT,
  );

  test(
    `at ${width} columns: a locked or rebasing row can't be selected or removed and says what to do`,
    () =>
      withApp(sandbox, { width, name: "browse blocked" }, async (app) => {
        await app.settled();
        await app.press(width >= 100 ? "right" : "enter");
        await app.waitFor("space select  enter remove");
        for (const [built, next] of [
          [alpha.locked!, "it's locked (agent session); unlock it first"],
          [alpha.rebasing!, "finish or abort the rebase first"],
        ] as const) {
          let frame = await app.focus(built.branch);
          frame = await app.waitFor(`Can't be removed: ${next}`);
          await app.press("space");
          frame = await app.waitFor(`! Can't select ${built.branch}: ${next}`);
          expect(rowOf(frame, built.branch)).toStartWith("– ");
          await app.press("x");
          frame = await app.waitFor(`! Can't remove ${built.branch}: ${next}`);
          expect(frame).not.toContain("╭─ Remove");
          expect(await exists(built.path!)).toBe(true);
        }
        expect(await exists(join(sandbox.cacheDir, "removals.log"))).toBe(false);
      }),
    TEST_TIMEOUT,
  );
}
