import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  dialog,
  dialogRow,
  exists,
  inSandbox,
  lineWith,
  removals,
  rowOf,
  squeeze,
  withApp,
  type App,
  TEST_TIMEOUT,
} from "../support/app";
import { createSandbox, type Built, type Sandbox } from "../support/fixture";
import { named, on, record, type Gate } from "../support/runners";

const WIDTHS = [120, 80] as const;

const open = (app: App) => app.press(app.width >= 100 ? "right" : "enter");

/** The branches among `names` that have a list row, in screen order. */
const order = (frame: string, names: string[]) =>
  frame
    .split("\n")
    .map((line) => names.find((name) => rowOf(line, name) !== null))
    .filter((name): name is string => name !== undefined);

/** Polls `check` until it holds; for disk and log effects the frame doesn't show. */
async function until(check: () => Promise<boolean>, what: string, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeout} ms waiting for ${what}`);
    await Bun.sleep(10);
  }
}

const releaseAll = (...gates: Gate[]) => {
  for (const gate of gates) gate.release();
};

for (const width of WIDTHS) {
  test(
    `at ${width} columns: a dirty worktree's files show, x names it as losing changes, Esc keeps it, y removes it (README: Removing worktrees)`,
    () =>
      inSandbox(async (sandbox) => {
        const alpha = await sandbox.repo("alpha");
        await alpha.squashMergedWorktree("clean");
        const dirty = await alpha.dirtyWorktree("dirty");
        await (await sandbox.repo("beta")).squashMergedWorktree("other");
        await withApp(sandbox, { width, name: "dirty" }, async (app) => {
          await app.settled();
          await open(app);
          await app.focus("dirty");
          let frame = await app.waitFor("uncommitted  README.md  notes.txt");
          expect(rowOf(frame, "dirty")).toStartWith("□ dirty uncommitted changes ");

          await app.press("x");
          frame = await app.waitFor("╭─ Remove");
          expect(lineWith(frame, "╭─")).toContain(
            ` Remove 1 worktree · up to ${app.size(dirty)}? `,
          );
          expect(dialogRow(frame, "dirty")).toBe(`• dirty alpha ${app.size(dirty)}`);
          expect(squeeze(lineWith(dialog(frame), "! Discards")).trim()).toBe(
            "│ ! Discards uncommitted changes in dirty │",
          );
          expect(dialog(frame)).not.toContain("Nothing uncommitted");
          expect(dialog(frame)).toContain("Merged branches are deleted.");

          await app.press("escape");
          frame = await app.waitFor((text) => !text.includes("╭─"));
          expect(rowOf(frame, "dirty")).toStartWith("□ dirty uncommitted changes ");
          expect(await exists(dirty.path!)).toBe(true);
          expect(await removals(sandbox)).toEqual([]);

          await app.press("x");
          await app.waitFor("! Discards uncommitted changes in dirty");
          await app.press("y");
          frame = await app.waitFor(/[✓!✗] (Removed|Removal)/);
          expect(frame).toContain("✓ Removed 1 worktree · ");
          frame = await app.waitFor((text) => rowOf(text, "dirty") === null);
          expect(rowOf(frame, "clean")).not.toBeNull();
          expect(await exists(dirty.path!)).toBe(false);
          expect(
            (await removals(sandbox)).map(({ branch, flags, exitCode }) => ({
              branch,
              flags,
              exitCode,
            })),
          ).toEqual([{ branch: "dirty", flags: ["-f", "--reap"], exitCode: 0 }]);
        });
      }),
    TEST_TIMEOUT,
  );

  test(
    `at ${width} columns: x on a Broken row offers to prune Git's record, and y prunes it (README: Verdicts, Broken)`,
    () =>
      inSandbox(async (sandbox) => {
        const alpha = await sandbox.repo("alpha");
        const kept = await alpha.squashMergedWorktree("kept");
        const gone = await alpha.deletedWorktree("gone");
        await (await sandbox.repo("beta")).squashMergedWorktree("other");
        const listed = async () =>
          (await alpha.git("worktree", "list", "--porcelain"))
            .split("\n")
            .filter((line) => line.startsWith("worktree "))
            .map((line) => line.slice(9))
            .sort();
        expect(await listed()).toEqual([alpha.path, gone.path!, kept.path!].sort());
        await withApp(sandbox, { width, name: "prune" }, async (app) => {
          await app.settled();
          await open(app);
          let frame = await app.focus("gone");
          expect(rowOf(frame, "gone")).toMatch(/^– gone folder missing /);
          expect(frame).toContain("enter prune");

          await app.press("x");
          frame = await app.waitFor("╭─ Prune");
          expect(lineWith(frame, "╭─")).toContain(" Prune 1 missing worktree record in alpha? ");
          expect(dialog(frame)).toContain(
            "The folders are already gone; this removes only Git's records of them.",
          );
          expect(dialog(frame)).toContain(" Prune  y / enter ");
          await app.press("y");
          frame = await app.waitFor("✓ Pruned 1 record in alpha");
          frame = await app.waitFor((text) => rowOf(text, "gone") === null);
          expect(rowOf(frame, "kept")).not.toBeNull();
          expect(await listed()).toEqual([alpha.path, kept.path!].sort());
          expect(await exists(kept.path!)).toBe(true);
          expect(await removals(sandbox)).toEqual([]);
        });
      }),
    TEST_TIMEOUT,
  );

  test(
    `at ${width} columns: Esc on the projects stops a running removal after the current worktree, and the rest come back (README: Keys, Esc)`,
    () =>
      inSandbox(async (sandbox) => {
        const alpha = await sandbox.repo("alpha");
        const built = [
          await alpha.squashMergedWorktree("one"),
          await alpha.squashMergedWorktree("two"),
          await alpha.squashMergedWorktree("three"),
        ];
        await (await sandbox.repo("beta")).squashMergedWorktree("other");
        const recorder = record(sandbox.runner);
        let started = 0;
        const second = recorder.gate((call) => named("wt", "remove")(call) && ++started === 2);
        const branchAt = (path: string) => built.find((one) => one.path === path)!.branch;
        await withApp(
          sandbox,
          { width, runner: recorder.runner, name: "esc stops" },
          async (app) => {
            let held: string;
            try {
              await app.settled();
              await open(app);
              await app.press("a");
              await app.waitFor("Selected 3 Safe worktrees");
              await app.press("x");
              await app.waitFor("╭─ Remove 3 worktrees");
              await app.press("y");
              held = branchAt((await second.reached).args.at(-1)!);
              let frame = await app.waitFor(`Removing 2 of 3: ${held}`);
              expect(frame).not.toContain("esc stop after this one");
              await app.press("escape");
              frame = await app.waitFor("esc stop after this one");
              expect(lineWith(frame, "Removing 2 of 3")).toContain(`Removing 2 of 3: ${held} `);
              await app.press("escape");
              frame = await app.waitFor("! Stopping after the current worktree");
              expect(frame).not.toContain("esc stop after this one");
            } finally {
              second.release();
            }
            const first = branchAt(recorder.calls.find(named("wt", "remove"))!.args.at(-1)!);
            const last = built
              .map((one) => one.branch)
              .find((name) => name !== first && name !== held)!;
            let frame = await app.waitFor(`! Removed 2 of 3 · ${last} not removed, see details`);
            if (width >= 100) {
              frame = await app.waitFor((text) => rowOf(text, last) !== null);
              expect(rowOf(frame, last)).toStartWith(`✗ ${last} removal failed now `);
            }
            await open(app);
            frame = await app.waitFor("space select");
            expect(rowOf(frame, last)).toStartWith(`✗ ${last} removal failed now `);
            frame = await app.focus(last);
            frame = await app.waitFor("Last removal failed: Cancelled");
            expect(rowOf(frame, held)).toBeNull();
            expect(rowOf(frame, first)).toBeNull();
            expect(
              recorder.calls
                .filter(named("wt", "remove"))
                .map((call) => branchAt(call.args.at(-1)!)),
            ).toEqual([first, held]);
            const byName = Object.fromEntries(built.map((one) => [one.branch, one.path!]));
            expect([
              await exists(byName[first]!),
              await exists(byName[held]!),
              await exists(byName[last]!),
            ]).toEqual([false, false, true]);
            expect(await alpha.git("branch", "--list", "--format=%(refname:short)", last)).toBe(
              last,
            );
          },
        );
      }),
    TEST_TIMEOUT,
  );

  test(
    `at ${width} columns: a removal confirmed while another runs is queued and runs after it (README: you can queue more)`,
    () =>
      inSandbox(async (sandbox) => {
        const alpha = await sandbox.repo("alpha");
        const first = await alpha.squashMergedWorktree("first");
        const second = await alpha.squashMergedWorktree("second");
        await (await sandbox.repo("beta")).squashMergedWorktree("other");
        const recorder = record(sandbox.runner);
        const firstGate = recorder.gate(on(named("wt", "remove"), first.path!));
        const secondGate = recorder.gate(on(named("wt", "remove"), second.path!));
        await withApp(sandbox, { width, runner: recorder.runner, name: "queue" }, async (app) => {
          try {
            await app.settled();
            await open(app);
            await app.focus("first");
            await app.press("x");
            await app.waitFor("╭─ Remove 1 worktree");
            await app.press("y");
            await firstGate.reached;
            let frame = await app.waitFor("Removing 1 of 1: first");
            expect(rowOf(frame, "first")).toBeNull();

            await app.focus("second");
            await app.press("x");
            frame = await app.waitFor("╭─ Remove 1 worktree");
            expect(dialogRow(frame, "second")).toBe(`• second alpha ${app.size(second)}`);
            await app.press("y");
            frame = await app.waitFor("Queued 1 worktree after the current removal");
            expect(rowOf(frame, "second")).toBeNull();
            expect(recorder.count(named("wt", "remove"))).toBe(1);
            expect(recorder.count(named("df"))).toBe(1);

            firstGate.release();
            await secondGate.reached;
            frame = await app.waitFor("✓ Removed 1 worktree · ");
            expect(await exists(first.path!)).toBe(false);
            expect(await exists(second.path!)).toBe(true);
            expect(rowOf(frame, "second")).toBeNull();
          } finally {
            releaseAll(firstGate, secondGate);
          }
          await until(async () => (await removals(sandbox)).length === 2, "the second removal");
          expect(await exists(second.path!)).toBe(false);
          expect(
            recorder.calls.filter(named("wt", "remove")).map((call) => call.args.at(-1)),
          ).toEqual([first.path!, second.path!]);
          expect(
            (await removals(sandbox)).map(({ branch, exitCode }) => ({ branch, exitCode })),
          ).toEqual([
            { branch: "first", exitCode: 0 },
            { branch: "second", exitCode: 0 },
          ]);
          const frame = await app.waitFor("✓ Removed 1 worktree · ");
          expect(rowOf(frame, "first")).toBeNull();
          expect(rowOf(frame, "second")).toBeNull();
        });
      }),
    TEST_TIMEOUT,
  );
}

let shared: Sandbox;
let sized: Record<string, Built>;

beforeAll(async () => {
  shared = await createSandbox();
  const alpha = await shared.repo("alpha");
  const beta = await shared.repo("beta");
  sized = {
    small: await alpha.sizedWorktree("small", { kib: 256 }),
    big: await alpha.sizedWorktree("big", { kib: 2048 }),
    mid: await alpha.sizedWorktree("mid", { kib: 1024 }),
    solo: await beta.sizedWorktree("solo", { kib: 512 }),
  };
}, 30_000);

afterAll(() => shared?.cleanup());

const ALPHA = ["small", "big", "mid"];

for (const width of WIDTHS)
  test(
    `at ${width} columns: s and S sort by size, [ and ] switch projects, the selection carries across screens, v groups by repo (README: Keys)`,
    () =>
      withApp(shared, { width, name: "browse keys" }, async (app) => {
        await app.settled();
        await open(app);
        let frame = await app.waitFor("s sort: size ↓");
        expect(order(frame, ALPHA)).toEqual(["big", "mid", "small"]);
        await app.press("S");
        frame = await app.waitFor("s sort: size ↑");
        expect(order(frame, ALPHA)).toEqual(["small", "mid", "big"]);
        await app.press("s");
        await app.waitFor("s sort: age ↓");
        await app.press("s");
        await app.waitFor("s sort: repo ↑");
        await app.press("s");
        frame = await app.waitFor("s sort: size ↓");
        expect(order(frame, ALPHA)).toEqual(["big", "mid", "small"]);

        await app.focus("mid");
        await app.press("space");
        frame = await app.waitFor((text) => rowOf(text, "mid")?.startsWith("■ ") ?? false);
        const selected = `■ 1 selected · up to ${app.size(sized.mid!)}`;
        expect(frame).toContain(selected);

        await app.press("]");
        frame = await app.waitFor("wt-dash › beta");
        expect(order(frame, [...ALPHA, "solo"])).toEqual(["solo"]);
        expect(frame).toContain(selected);
        await app.press("]");
        await app.press("[");
        frame = await app.waitFor("wt-dash › alpha");
        expect(rowOf(frame, "mid")).toStartWith("■ mid ");
        await app.press("[");
        frame = await app.frame();
        expect(lineWith(frame, "wt-dash")).toStartWith("wt-dash › alpha");

        await app.press("v");
        await app.waitFor("Grouping by repo works in the all-projects view");

        await app.press("left");
        frame = await app.waitFor(`${selected}   x remove  esc clear`);
        expect(squeeze(lineWith(frame, /^(▌ | {2})alpha /))).toStartWith(
          width >= 100 ? "▌ alpha 3 ■1 " : "▌ alpha ■ 1 3 3 ",
        );
        await open(app);
        frame = await app.waitFor(`${selected}   enter remove  esc clear`);
        expect(rowOf(frame, "mid")).toStartWith("■ mid ");
        await app.press("escape");
        frame = await app.waitFor("Cleared 1 selection");
        expect(rowOf(frame, "mid")).toStartWith("□ mid ");

        await app.press("left");
        await app.press("g");
        await open(app);
        frame = await app.waitFor("v by repo");
        expect(lineWith(frame, "wt-dash")).toStartWith("wt-dash › all projects");
        expect(order(frame, [...ALPHA, "solo"])).toEqual(["big", "mid", "solo", "small"]);
        await app.press("v");
        frame = await app.waitFor("v by verdict");
        const grouped = frame
          .split("\n")
          .map(
            (line) =>
              /(?:^|│ )▸ (\S+) /u.exec(line)?.[1] ??
              /(?:^|│ )(?:▌ | {2})[□■] ● (\S+) /u.exec(line)?.[1],
          )
          .filter(Boolean);
        expect(grouped).toEqual(["alpha", "big", "mid", "small", "beta", "solo"]);
        expect(frame).not.toContain("✓ SAFE");
        await app.press("v");
        frame = await app.waitFor("v by repo");
        expect(frame).toContain("✓ SAFE  4 worktrees");
      }),
    TEST_TIMEOUT,
  );
