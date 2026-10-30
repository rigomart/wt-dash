import { cell, fitLine, lineWidth, seg, type Line } from "../line";
import type { UiState } from "../state";
import { dim } from "./common";
import type { RenderContext } from "./layout";
import { box, overlay } from "./dialogs";

function helpGroups(_state: UiState): Array<[string, Array<[string, string]>]> {
  return [
    [
      "MOVE",
      [
        ["↑↓ j k", "row"],
        ["pgup pgdn", "page"],
        ["g G", "first / last"],
        ["i", "full details"],
      ],
    ],
    [
      "PROJECTS",
      [
        ["enter →", "open project or all"],
        ["← esc", "back to projects"],
        ["tab", "switch projects / list"],
        ["[ ]", "previous / next project"],
      ],
    ],
    [
      "FIND",
      [
        ["1-6", "verdict tab"],
        ["/", "search as you type"],
        ["s S", "sort / reverse"],
        ["v", "group by repo or verdict"],
      ],
    ],
    [
      "CLEAN UP",
      [
        ["space", "select row"],
        ["a", "all Safe in view / project"],
        ["enter x", "remove selected or focused"],
        ["y enter", "confirm in the dialog"],
        ["D", "dialog: unmerged branches"],
        ["e", "dialog: leave processes"],
        ["enter", "on Broken: prune record"],
      ],
    ],
    [
      "OTHER",
      [
        ["esc", "undo one step"],
        ["r", "rescan all repos"],
        ["R", "remeasure size"],
        ["q ^C", "quit"],
      ],
    ],
  ];
}

export function withHelp(base: Line[], state: UiState, ctx: RenderContext): Line[] {
  const { theme, width, height } = ctx;
  const boxWidth = Math.min(width - 2, 80);
  const inner = boxWidth - 4;
  const groups = helpGroups(state).map(([title, keys]) => [
    ...(title ? [[seg(title, { dim: true, bold: true })]] : [[]]),
    ...keys.map(([name, action]): Line => [
      cell(name, 11, { fg: theme.accent, bold: true }),
      seg(action),
    ]),
  ]);
  const leftColumn = groups
    .filter((_, index) => index % 2 === 0)
    .flatMap((group, index) => (index ? [[], ...group] : group));
  const rightColumn = groups
    .filter((_, index) => index % 2 === 1)
    .flatMap((group, index) => (index ? [[], ...group] : group));
  const columnWidth = (column: Line[]) => Math.max(...column.map(lineWidth));
  const whole = columnWidth(leftColumn);
  const left = whole + 2 + columnWidth(rightColumn) <= inner ? whole : Math.floor((inner - 2) / 2);
  let content: Line[];
  if (inner >= 60) {
    const rows = Math.max(leftColumn.length, rightColumn.length);
    content = Array.from({ length: rows }, (_, index) => [
      ...fitLine(leftColumn[index] ?? [], left),
      seg("  "),
      ...(rightColumn[index] ?? []),
    ]);
  } else content = groups.flatMap((group, index) => (index ? [[], ...group] : group));
  content.push(
    [],
    [
      dim("Colors: "),
      seg("● safe  ", { fg: theme.safe }),
      seg("● review  ", { fg: theme.review }),
      seg("● busy  ", { fg: theme.busy }),
      seg("● broken  ", { fg: theme.broken }),
      seg("● orphaned", { fg: theme.orphaned }),
    ],
  );
  return overlay(
    base,
    box("Keys", content.slice(0, Math.max(1, height - 2)), " ? or esc closes ", boxWidth),
    ctx,
  );
}
