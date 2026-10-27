import { expect, test } from "bun:test";
import type { WorktreeRow } from "../src/core/types";
import { agoLabel, statusLabel, upstreamLabel } from "../src/ui/format";
import { clip, fitLine, lineWidth, middle, seg, spread, wrap } from "../src/ui/line";

function row(overrides: Partial<WorktreeRow> = {}): WorktreeRow {
  return {
    id: "a",
    repoPath: "/r",
    repoName: "r",
    path: "/r/w",
    branch: "b",
    headSha: "abc",
    committedAt: null,
    tool: "Claude",
    changes: {
      staged: false,
      modified: false,
      untracked: false,
      renamed: false,
      deleted: false,
      conflicted: false,
    },
    upstreamAhead: 0,
    mainState: "integrated",
    lockReason: null,
    mainAhead: null,
    defaultBranch: "main",
    mainBase: "main",
    locked: false,
    prunable: false,
    operation: null,
    sizeKiB: null,
    sizeMeasuredAt: null,
    verdict: "Safe",
    reason: "",
    ...overrides,
  };
}

test("one Git status explains the verdict in a few plain words", () => {
  expect(statusLabel(row())).toBe("merged");
  expect(statusLabel(row({ integrationReason: "same_commit" }))).toBe("no new commits");
  expect(statusLabel(row({ mainState: "would_conflict" }))).toBe("unmerged commits");
  expect(statusLabel(row({ mainState: "ahead" }))).toBe("unmerged commits");
  expect(statusLabel(row({ locked: true }))).toBe("locked");
  expect(statusLabel(row({ upstreamAhead: 2 }))).toBe("unpushed commits");
  expect(statusLabel(row({ changes: { ...row().changes!, untracked: true } }))).toBe(
    "uncommitted changes",
  );
});

test("relative times never read like 'now ago'", () => {
  const now = Date.parse("2026-09-29T12:00:00Z");
  expect(agoLabel("2026-09-29T11:59:50Z", now)).toBe("just now");
  expect(agoLabel("2026-09-29T11:55:00Z", now)).toBe("5m ago");
  expect(agoLabel("2026-09-27T12:00:00Z", now)).toBe("2d ago");
});

test("middle truncation keeps both ends of a long branch", () => {
  expect(middle("feat/de9ea4be-a0fa-42e7-977f-35e48a5e41a4/B", 16)).toBe("feat/de9…e41a4/B");
  expect(middle("short", 16)).toBe("short");
});

test("wrapping prefers path separators", () => {
  expect(wrap("~/projects/my-app/.claude/worktrees/feature-login", 30)).toEqual([
    "~/projects/my-app/.claude/",
    "worktrees/feature-login",
  ]);
});

test("lines are cut and padded to an exact width, including wide characters", () => {
  const line = fitLine([seg("🤖 agent"), seg(" working")], 8);
  expect(lineWidth(line)).toBe(8);
  expect(clip("abcdef", 4)).toBe("abc…");
});

test("spread keeps the requested side when both do not fit", () => {
  const text = (line: ReturnType<typeof spread>) => line.map((item) => item.text).join("");
  expect(text(spread([seg("left side text")], [seg("q quit")], 12, "right"))).toBe("left  q quit");
  expect(text(spread([seg("left side text")], [seg("q quit")], 12, "left"))).toBe("left side te");
});

test("narrow STATUS cells truncate only the single Git label", () => {
  expect(statusLabel(row({ operation: "rebase" }), 10)).toBe("rebase in…");
  expect(statusLabel(row({ operation: "rebase" }), 0)).toBe("");
  expect(statusLabel(row({ locked: true, mainState: "ahead", upstreamAhead: 3 }))).toBe("locked");
  expect(upstreamLabel(row({ upstreamAhead: null }))).toBe("no tracking branch");
});
