import type { DashboardSnapshot, Verdict, WorktreeRow } from "../../core/types";
import { branchLabel, clockLabel, countLabel, rowsLabel, sizeLabel } from "../format";
import { fitLine, lineWidth, rule, seg, spread, textWidth, type Line, type Style } from "../line";
import { jobStatus, projectsReady, type ListView } from "../selectors";
import { TABS, VERDICTS, type Screen, type Tab, type Toast, type UiState } from "../state";
import { verdictColor, type Theme } from "../theme";
import { dim, key, spinner } from "./common";
import type { RenderContext } from "./layout";

export function keyHints(theme: Theme, pairs: Array<[string, string]>): Line {
  return pairs.flatMap(([name, action], index) => [
    ...(index ? [seg("  ")] : []),
    key(theme, name),
    dim(` ${action}`),
  ]);
}

function quitHint(theme: Theme): Line {
  return keyHints(theme, [
    ["?", "keys"],
    ["q", "quit"],
  ]);
}

export function toastLine(theme: Theme, toast: Toast): Line {
  const style: Record<Toast["tone"], [string, Style]> = {
    info: ["", {}],
    ok: ["✓ ", { fg: theme.safe }],
    warn: ["! ", { fg: theme.review, bg: theme.toastBg }],
    error: ["✗ ", { fg: theme.broken, bg: theme.toastBg }],
  };
  const [icon, look] = style[toast.tone];
  return [seg(` ${icon}${toast.text} `, look)];
}

function selectedKiB(state: UiState, snapshot: DashboardSnapshot): number {
  return snapshot.rows
    .filter((row) => state.selected.has(row.id))
    .reduce((sum, row) => sum + (row.sizeKiB ?? 0), 0);
}

export function statusLine(state: UiState, ctx: RenderContext): Line {
  const { theme } = ctx;
  if (state.toast) return toastLine(theme, state.toast);
  if (state.pending)
    return [
      seg(spinner(state), { fg: theme.accent }),
      seg(` ${state.pending.label}  `),
      ...keyHints(theme, [["esc", "cancel"]]),
    ];
  if (state.pruning) return [seg(spinner(state), { fg: theme.accent }), seg(" Pruning…")];
  if (state.jobs.length) return progressLine(state, ctx);
  return bannerLine(ctx) ?? [];
}

type SummaryPart = "projects" | "worktrees" | "size" | "sizing";

const SUMMARY_PARTS_BY_WIDTH: SummaryPart[][] = [
  ["projects", "worktrees", "size", "sizing"],
  ["worktrees", "size", "sizing"],
  ["worktrees", "size"],
  ["size"],
  [],
];

export function headerLine(
  state: UiState,
  ctx: RenderContext,
  screen: Screen,
  rows: WorktreeRow[],
  projects?: number,
): Line {
  const { snapshot, theme } = ctx;
  const progress = snapshot.progress;
  const total = rows.reduce((sum, row) => sum + (row.sizeKiB ?? 0), 0);
  const unknown = rows.filter((row) => row.kind === "worktree" && row.sizeKiB === null).length;
  const status: Line =
    progress.phase === "scanning"
      ? [
          seg(spinner(state), { fg: theme.accent }),
          dim(` scanning ${progress.reposDone}/${progress.reposTotal} repos`),
        ]
      : progress.phase === "error"
        ? [seg("scan failed", { fg: theme.broken })]
        : progress.phase === "complete"
          ? [dim(`scanned ${clockLabel(progress.completedAt)}  `), key(theme, "r"), dim(" rescan")]
          : [dim("starting…")];
  const place =
    screen.kind === "project"
      ? (rows[0]?.repoName ?? screen.repoPath.split("/").at(-1) ?? screen.repoPath)
      : screen.kind === "all"
        ? "all projects"
        : null;
  const title: Line = [seg("wt-dash", { bold: true })];
  if (place) title.push(dim(" › "), seg(place, { bold: true }));
  const parts: Record<SummaryPart, string> = {
    projects: projects === undefined ? "" : countLabel(projects, "project"),
    worktrees: rowsLabel(rows),
    size: `up to ${sizeLabel(total)}`,
    sizing: unknown ? `${unknown} sizing` : "",
  };
  const summary = (names: SummaryPart[]): Line => {
    const listing = !rows.length && progress.phase === "scanning";
    const shown =
      projectsReady(state, snapshot) && !listing
        ? names.map((name) => parts[name]).filter(Boolean)
        : [];
    return [dim(shown.map((part) => `${part} · `).join("")), ...status];
  };
  const right =
    SUMMARY_PARTS_BY_WIDTH.map(summary).find(
      (line) => lineWidth(title) + lineWidth(line) + 1 <= ctx.width,
    ) ?? summary([]);
  return spread(title, right, ctx.width, "right");
}

export function tabsLine(state: UiState, view: ListView, ctx: RenderContext): Line {
  const { theme, width, snapshot } = ctx;
  const short: Record<Tab, string> = {
    All: "All",
    Safe: "Safe",
    Review: "Rev",
    Busy: "Busy",
    Broken: "Brk",
  };
  const tone: Record<Tab, Style> = {
    All: {},
    Safe: { fg: theme.safe },
    Review: { fg: theme.review },
    Busy: { fg: theme.busy },
    Broken: { fg: theme.broken },
  };
  const left: Line = TABS.flatMap((tab) => {
    const count = view.counts[tab];
    let label = `${width < 64 ? short[tab] : tab} ${count}`;
    if (tab === "Safe" && width >= 100 && view.safeKiB) label += ` · ${sizeLabel(view.safeKiB)}`;
    const look: Style =
      tab === state.tab ? { reverse: true, bold: true } : { ...tone[tab], dim: count === 0 };
    return [seg(` ${label} `, look)];
  });
  let right: Line;
  if (state.searching) {
    right = [
      key(theme, "/ "),
      seg(state.search),
      seg(" ", { reverse: true }),
      dim(`  ${view.rows.length} of ${snapshot.rows.length}`),
    ];
  } else if (state.search) {
    right = [key(theme, "/ "), seg(state.search, { bold: true }), dim("  esc clears")];
  } else right = [key(theme, "/"), dim(" search")];
  return spread(left, right, width, state.searching || state.search ? "right" : "left");
}

export function meterLine(rows: WorktreeRow[], ctx: RenderContext): Line {
  const { theme, width } = ctx;
  const kib = (verdict: Verdict) =>
    rows.filter((row) => row.verdict === verdict).reduce((sum, row) => sum + (row.sizeKiB ?? 0), 0);
  const total = VERDICTS.reduce((sum, verdict) => sum + kib(verdict), 0);
  if (!total) return rule(width);
  const meter: Line = [];
  let used = 0;
  let running = 0;
  for (const verdict of VERDICTS) {
    running += kib(verdict);
    const end = Math.round((running / total) * width);
    if (end > used) meter.push(seg("━".repeat(end - used), { fg: verdictColor(theme, verdict) }));
    used = Math.max(used, end);
  }
  return fitLine(meter, width);
}

function bannerLine(ctx: RenderContext): Line | null {
  const { snapshot, theme } = ctx;
  if (snapshot.fatalError) return [seg(`✗ ${snapshot.fatalError}`, { fg: theme.broken })];
  const errors = Object.entries(snapshot.errors);
  if (!errors.length) return null;
  const [repo, message] = errors[0]!;
  return [
    seg(
      `! ${countLabel(errors.length, "repo")} failed to scan: ${repo.split("/").at(-1)}: ${message}`,
      { fg: theme.review },
    ),
  ];
}

function progressLine(state: UiState, ctx: RenderContext): Line {
  const { theme, width } = ctx;
  const statuses = state.jobs.flatMap((job) => job.order.map((id) => job.status[id]!));
  const total = statuses.length;
  const done = statuses.filter((status) => status !== "waiting" && status !== "removing").length;
  const failed = statuses.filter(
    (status) => status === "failed" || status === "skipped" || status === "unverified",
  ).length;
  const current = state.jobs
    .flatMap((job) => job.plan.entries)
    .find((entry) => jobStatus(state, entry.row.id) === "removing");
  const stopping = state.jobs.every((job) => job.stopping);
  const text =
    `Removing ${Math.min(done + 1, total)} of ${total}` +
    (current ? `: ${branchLabel(current.row)}` : "");
  const barWidth = Math.max(0, Math.min(24, width - textWidth(text) - 40));
  const filled = total ? Math.round((done / total) * barWidth) : 0;
  const left: Line = [seg(spinner(state), { fg: theme.accent }), seg(` ${text}  `)];
  if (barWidth >= 6)
    left.push(
      seg("━".repeat(filled), { fg: theme.safe }),
      dim("━".repeat(barWidth - filled)),
      seg("  "),
    );
  if (failed) left.push(seg(`${failed} not removed  `, { fg: theme.review }));
  const escStopsRemoval = state.screen.kind === "projects";
  const right: Line = stopping
    ? [seg("stopping after this one", { fg: theme.review })]
    : escStopsRemoval
      ? keyHints(theme, [["esc", "stop after this one"]])
      : [];
  return spread(left, right, width);
}

export function listFooter(
  state: UiState,
  ctx: RenderContext,
  focus: WorktreeRow | null,
  sidebar: boolean,
): Line {
  const { theme, width } = ctx;
  let left: Line;
  if (state.confirm)
    left = keyHints(theme, [
      ["y / enter", state.confirm.kind],
      ["esc", "cancel"],
    ]);
  else if (state.searching)
    left = [
      dim("type to filter  "),
      ...keyHints(theme, [
        ["↑↓", "move"],
        ["enter", "keep"],
        ["esc", "clear"],
      ]),
    ];
  else if (state.expanded)
    left = keyHints(theme, [
      ["↑↓", "scroll"],
      ["i", "back"],
    ]);
  else if (state.selected.size) {
    left = [
      seg("■ ", { fg: theme.safe }),
      seg(`${state.selected.size} selected`, { bold: true }),
      dim(` · up to ${sizeLabel(selectedKiB(state, ctx.snapshot))}   `),
      ...keyHints(theme, [
        [state.screen.kind === "projects" ? "x" : "enter", "remove"],
        ["esc", "clear"],
      ]),
    ];
  } else if (state.screen.kind === "projects" && !projectsReady(state, ctx.snapshot)) {
    left = [];
  } else if (state.screen.kind === "projects") {
    left = keyHints(theme, [
      [sidebar ? "→" : "enter", sidebar ? "worktrees" : "open"],
      ...(ctx.canAct ? [["a", "select safe"] as [string, string]] : []),
      ["/", "search"],
    ]);
  } else {
    const action: Array<[string, string]> =
      focus?.verdict === "Broken"
        ? [["enter", "prune"]]
        : [
            ["space", "select"],
            ["enter", "remove"],
          ];
    const view: Array<[string, string]> = [
      ["/", "search"],
      ...(state.screen.kind === "all"
        ? [["v", state.grouped ? "by verdict" : "by repo"] as [string, string]]
        : []),
      ["s", `sort: ${state.sort} ${state.descending ? "↓" : "↑"}`],
      ["←", "projects"],
    ];
    left = keyHints(theme, ctx.canAct ? [...action, ["a", "all safe"], ...view] : view);
  }
  return spread(left, quitHint(theme), width, "right");
}
