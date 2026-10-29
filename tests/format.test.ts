import { expect, test } from "bun:test";
import type { WorktreeRow } from "../src/core/types";
import {
  agoLabel,
  aheadLabel,
  branchLabel,
  divergenceLabel,
  homeText,
  rowsLabel,
  statusLabel,
  upstreamLabel,
} from "../src/ui/format";
import { clip, fitLine, lineWidth, middle, seg, spread, wrap } from "../src/ui/line";
import { orphan } from "./support/update";

function row(overrides: Partial<WorktreeRow> = {}): WorktreeRow {
  return {
    id: "a",
    repoPath: "/r",
    repoName: "r",
    path: "/r/w",
    branch: "b",
    headSha: "abc",
    committedAt: null,
    createdAt: null,
    kind: "worktree",
    marker: null,
    markerSetAt: null,
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
    mainBehind: null,
    mainDiff: null,
    subject: null,
    description: null,
    vars: null,
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

test("counts branches without a worktree apart from worktrees", () => {
  const branch = row({ kind: "branch", path: null });
  expect(rowsLabel([row(), row()])).toBe("2 worktrees");
  expect(rowsLabel([])).toBe("0 worktrees");
  expect(rowsLabel([branch])).toBe("1 branch");
  expect(rowsLabel([row(), branch, branch], "Safe")).toBe("1 Safe worktree and 2 branches");
  expect(rowsLabel([branch, branch], "Safe")).toBe("2 Safe branches");
});

test("counts orphans as orphaned folders, apart from worktrees and branches", () => {
  const branch = row({ kind: "branch", path: null });
  expect(rowsLabel([orphan("x", 10)])).toBe("1 orphaned folder");
  expect(rowsLabel([row(), row(), orphan("x", 10)])).toBe("2 worktrees and 1 orphaned folder");
  expect(rowsLabel([row(), branch, orphan("x", 10), orphan("y", 10)])).toBe(
    "1 worktree, 1 branch and 2 orphaned folders",
  );
  expect(rowsLabel([row(), orphan("x", 10)], "Safe")).toBe("1 Safe worktree and 1 orphaned folder");
});

test("an orphan is named by its folder, and its reason shortens the home folder to ~", () => {
  expect(branchLabel(orphan("abcd", 10))).toBe("abcd/app");
  expect(branchLabel(orphan("abcd", 10, { path: "/home/me/.codex/worktrees/abcd" }))).toBe("abcd");
  expect(statusLabel(orphan("abcd", 10))).toBe("repository gone");
  expect(homeText("Its repository at /home/me/old/app no longer exists.", "/home/me")).toBe(
    "Its repository at ~/old/app no longer exists.",
  );
  expect(homeText("Its repository at /home/meg/app no longer exists.", "/home/me")).toBe(
    "Its repository at /home/meg/app no longer exists.",
  );
  expect(homeText("Codex left this folder behind with no worktree inside.", "")).toBe(
    "Codex left this folder behind with no worktree inside.",
  );
});

test("the work a branch carries reads as commits ahead and lines changed, leaving out what is zero or unknown", () => {
  const ahead = row({ mainAhead: 3, mainBehind: 2, mainDiff: { added: 18, deleted: 4 } });
  expect(aheadLabel(ahead)).toBe("3 commits ahead of main · +18 −4");
  expect(divergenceLabel(ahead)).toBe("3 ahead of main · 2 behind · +18 −4 lines");
  const one = row({ mainAhead: 1, mainBehind: 0, mainDiff: { added: 1, deleted: 0 } });
  expect(aheadLabel(one)).toBe("1 commit ahead of main · +1");
  expect(divergenceLabel(one)).toBe("1 ahead of main · +1 line");
  const none = row({ mainAhead: 0, mainBehind: 5, mainDiff: { added: 0, deleted: 0 } });
  expect(aheadLabel(none)).toBe("no commits beyond main");
  expect(divergenceLabel(none)).toBe("none beyond main · 5 behind");
  expect(aheadLabel(row({ mainAhead: 2, mainDiff: null }))).toBe("2 commits ahead of main");
  expect(aheadLabel(row({ mainAhead: null }))).toBeNull();
  expect(divergenceLabel(row({ mainAhead: null }))).toBeNull();
});
