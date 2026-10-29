import { recentAgentMark } from "../../core/assess";
import type { RemovalEntry } from "../../core/actions";
import type { WorktreeRow } from "../../core/types";
import { branchLabel, countLabel, rowsLabel, sizeLabel } from "../format";
import {
  cell,
  clip,
  fitLine,
  lineWidth,
  middle,
  seg,
  sliceLine,
  textWidth,
  wrap,
  type Line,
  type Style,
} from "../line";
import type { Confirm, UiState } from "../state";
import type { Theme } from "../theme";
import { dim, key } from "./common";
import type { RenderContext } from "./layout";
import { toastLine } from "./chrome";
import { rowSize } from "./list";

function names(entries: RemovalEntry[]): string {
  const labels = entries.map((entry) => branchLabel(entry.row));
  return labels.length <= 2
    ? labels.join(" and ")
    : `${labels.slice(0, 2).join(", ")} +${labels.length - 2} more`;
}

export function withConfirm(
  base: Line[],
  state: UiState,
  confirm: Confirm,
  ctx: RenderContext,
): Line[] {
  const boxWidth = Math.min(ctx.width - 2, 76);
  const inner = boxWidth - 4;
  const { title, content, answer } =
    confirm.kind === "prune" ? pruneDialog(confirm, ctx, inner) : removeDialog(confirm, ctx, inner);
  const message = state.toast ? [toastLine(ctx.theme, state.toast), []] : [];
  return overlay(
    base,
    box(title, [...content, ...message, answer], " esc cancels ", boxWidth),
    ctx,
  );
}

function buttons(theme: Theme, verb: string): Line {
  return [
    seg(` ${verb}  y / enter `, { fg: theme.broken, reverse: true, bold: true }),
    seg("   "),
    seg("[ "),
    seg("Cancel  esc", { bold: true }),
    seg(" ]"),
  ];
}

function pruneDialog(
  confirm: Extract<Confirm, { kind: "prune" }>,
  ctx: RenderContext,
  inner: number,
) {
  const repo = confirm.plan.repoPath.split("/").at(-1);
  return {
    title: `Prune ${countLabel(confirm.plan.records.length, "missing worktree record")} in ${repo}?`,
    content: [
      ...wrap("The folders are already gone; this removes only Git's records of them.", inner).map(
        (text) => [dim(text)],
      ),
      [],
    ],
    answer: buttons(ctx.theme, "Prune"),
  };
}

function withLiveSizes(entries: RemovalEntry[], rows: WorktreeRow[]): RemovalEntry[] {
  const live = new Map(rows.map((row) => [row.id, row]));
  return entries.map((entry) => {
    const sizeKiB = live.get(entry.row.id)?.sizeKiB ?? entry.row.sizeKiB;
    return { ...entry, row: { ...entry.row, sizeKiB } };
  });
}

function removeDialog(
  confirm: Extract<Confirm, { kind: "remove" }>,
  ctx: RenderContext,
  inner: number,
) {
  const { theme } = ctx;
  const { ready, blocked } = confirm;
  const sized = withLiveSizes(ready, ctx.snapshot.rows);
  const kib = sized.reduce((sum, entry) => sum + (entry.row.sizeKiB ?? 0), 0);
  const unsized = sized.filter(
    (entry) => entry.row.kind === "worktree" && entry.row.sizeKiB === null,
  ).length;
  const size = [
    kib || !unsized ? `up to ${sizeLabel(kib)}` : "",
    unsized ? `${unsized} sizing` : "",
  ].filter(Boolean);
  const notes: Line[] = [];
  const dirty = ready.filter((entry) => entry.requiresDiscard);
  const warn = (text: string) => wrap(text, inner).map((part) => [seg(part, { fg: theme.review })]);
  const marked = ready.filter((entry) => recentAgentMark(entry.row));
  if (marked.length)
    notes.push(
      ...warn(
        marked.length === 1
          ? `! ${names(marked)}: ${recentAgentMark(marked[0]!.row)}`
          : `! Agents were recently active in ${names(marked)}`,
      ),
    );
  if (dirty.length) notes.push(...warn(`! Discards uncommitted changes in ${names(dirty)}`));
  if (blocked.length) {
    notes.push(
      ...warn(
        blocked.length === 1
          ? `! Skips ${names(blocked)}: ${blocked[0]!.blockedReason}`
          : `! Skips ${names(blocked)}, which changed or can't be removed`,
      ),
    );
  }
  if (!dirty.length && !blocked.length && ready.some((entry) => entry.row.kind === "worktree"))
    notes.push(
      ...wrap("Nothing uncommitted. Ignored files and caches go with them.", inner).map((text) => [
        dim(text),
      ]),
    );
  const unmerged = ready.filter((entry) => entry.branchWillBeRetained);
  const merged = ready.filter((entry) => entry.row.branch !== null && !entry.branchWillBeRetained);
  const bare = unmerged.filter((entry) => entry.row.kind === "branch");
  if (bare.length && !confirm.deleteUnmerged)
    notes.push(...warn(`! Skips ${names(bare)} unless you press D: not merged, and no worktree`));
  const options: Line[] = [];
  if (unmerged.length) {
    const count = countLabel(unmerged.length, "unmerged branch", "unmerged branches");
    options.push([
      confirm.deleteUnmerged
        ? seg(`Also deletes ${count}  `, { fg: theme.review })
        : dim(`Keeps ${count}  `),
      key(theme, "D"),
      dim(confirm.deleteUnmerged ? " keep them" : " delete too"),
    ]);
  } else if (merged.length) options.push([dim("Merged branches are deleted.")]);
  options.push([
    confirm.reap
      ? dim("Stops processes running inside  ")
      : seg("Processes inside keep running  ", { fg: theme.review }),
    key(theme, "e"),
    dim(confirm.reap ? " leave them" : " stop them"),
  ]);
  const tail: Line[] = [[], ...notes, [], ...options, []];
  const room = Math.max(1, ctx.height - 3 - tail.length);
  const shown = sized.length > room ? sized.slice(0, room - 1) : sized;
  const sizeWidth = 9;
  const repoWidth = inner >= 50 ? 14 : 0;
  const rows: Line[] = shown.map((entry) => [
    cell(
      `• ${middle(branchLabel(entry.row), inner - repoWidth - sizeWidth - 3)}`,
      inner - repoWidth - sizeWidth,
      entry.requiresDiscard ? { fg: theme.review } : {},
    ),
    cell(entry.row.repoName, repoWidth, { dim: true }),
    cell(rowSize(entry.row), sizeWidth, { dim: true }, "right"),
  ]);
  if (shown.length < ready.length) rows.push([dim(`  +${ready.length - shown.length} more`)]);
  return {
    title: `Remove ${[rowsLabel(ready.map((entry) => entry.row)), ...size].join(" · ")}?`,
    content: [...rows, ...tail],
    answer: buttons(theme, `Remove ${ready.length}`),
  };
}

export function box(title: string, content: Line[], closing: string, boxWidth: number): Line[] {
  const inner = boxWidth - 4;
  const border: Style = { dim: true };
  const heading = ` ${clip(title, Math.max(1, boxWidth - 6))} `;
  return [
    [
      seg("╭─", border),
      seg(heading, { bold: true }),
      seg("─".repeat(Math.max(0, boxWidth - 3 - textWidth(heading))) + "╮", border),
    ],
    ...content.map((line): Line => [seg("│ ", border), ...fitLine(line, inner), seg(" │", border)]),
    [
      seg("╰" + "─".repeat(Math.max(0, boxWidth - 3 - closing.length)), border),
      seg(closing, { dim: true }),
      seg("─╯", border),
    ],
  ];
}

const DIALOG_ANSWER_AND_EDGE = 2;

function fitHeightKeepingEnd(lines: Line[], height: number, kept: number): Line[] {
  if (lines.length <= height) return lines;
  return [...lines.slice(0, Math.max(1, height - kept)), ...lines.slice(-kept)];
}

export function overlay(base: Line[], lines: Line[], ctx: RenderContext): Line[] {
  const { width, height } = ctx;
  const boxWidth = lineWidth(lines[0] ?? []);
  const shown = fitHeightKeepingEnd(lines, height, DIALOG_ANSWER_AND_EDGE);
  const y = Math.max(0, Math.floor((height - shown.length) / 2));
  const x = Math.max(0, Math.floor((width - boxWidth) / 2));
  const faded: Line[] = base.map((line) => line.map((item) => seg(item.text, { dim: true })));
  shown.forEach((line, index) => {
    if (y + index >= height) return;
    faded[y + index] = [
      ...sliceLine(faded[y + index]!, 0, x),
      ...fitLine(line, boxWidth),
      ...sliceLine(faded[y + index]!, x + boxWidth, width),
    ];
  });
  return faded.map((line) => fitLine(line, width));
}
