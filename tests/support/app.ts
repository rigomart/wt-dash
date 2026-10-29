import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeyEvent } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { CommandRunner } from "../../src/core/types";
import { runTerminal } from "../../src/ui/terminal";
import { sizeLabel } from "../../src/ui/format";
import { createSandbox, type Built, type Sandbox, type Services } from "./fixture";

/** Keys `press` sends by name; anything else is sent as typed text, so "D" is a shifted d. */
const NAMED = ["escape", "enter", "tab", "space", "backspace", "up", "down", "left", "right"];

const WAIT_TIMEOUT = 5000;
const POLLS_TO_SHOW_SETTLED_FRAME = 2;

export { TEST_TIMEOUT } from "./fixture";

export type FrameMatch = string | RegExp | ((frame: string) => boolean);

export interface App {
  sandbox: Sandbox;
  services: Services;
  width: number;
  height: number;
  /** Sends one key and resolves once the app has received it. */
  press(key: string): Promise<void>;
  type(text: string): Promise<void>;
  frame(): Promise<string>;
  /** Renders until the frame matches, and returns that frame; throws with the last frame on timeout. */
  waitFor(match: FrameMatch, options?: { timeout?: number }): Promise<string>;
  /**
   * Waits until the scan is complete and every worktree with a folder has a size, then returns a frame drawn
   * after that.
   */
  settled(options?: { timeout?: number }): Promise<string>;
  /** The size column text the app shows for a built worktree, from the size cache. */
  size(built: Built): string;
  /** Presses ↓ or ↑ until the focused list row is `branch`. */
  focus(branch: string): Promise<string>;
  /** Every distinct frame rendered so far, oldest first. */
  frames: string[];
  /** Quits like a user would, waits for runTerminal to return, and closes the services. */
  close(): Promise<void>;
}

const describeMatch = (match: FrameMatch) =>
  typeof match === "function" ? match.name || "predicate" : JSON.stringify(String(match));

const matches = (frame: string, match: FrameMatch): boolean =>
  typeof match === "string"
    ? frame.includes(match)
    : match instanceof RegExp
      ? match.test(frame)
      : match(frame);

/** Starts the real runTerminal on the sandbox's real services, in an OpenTUI test renderer. */
export async function startApp(
  sandbox: Sandbox,
  { width, height = 40, runner }: { width: number; height?: number; runner?: CommandRunner },
): Promise<App> {
  const services = await sandbox.services({ runner });
  const setup = await createTestRenderer({ width, height });
  const running = runTerminal(services.dashboard, {
    renderer: setup.renderer,
    actions: services.actions,
    home: sandbox.home,
  });
  const frames: string[] = [];
  let closed = false;

  async function frame(): Promise<string> {
    await setup.renderOnce();
    const text = setup.captureCharFrame();
    if (frames.at(-1) !== text) frames.push(text);
    return text;
  }

  async function press(key: string): Promise<void> {
    const name = key === "enter" ? "return" : key;
    const received = new Promise<void>((resolve) => {
      const seen = (event: KeyEvent) => {
        if (NAMED.includes(key) ? event.name !== name : event.sequence !== key) return;
        setup.renderer.keyInput.off("keypress", seen);
        resolve();
      };
      setup.renderer.keyInput.on("keypress", seen);
    });
    const input = setup.mockInput;
    if (key === "escape") input.pressEscape();
    else if (key === "enter") input.pressEnter();
    else if (key === "tab") input.pressTab();
    else if (key === "backspace") input.pressBackspace();
    else if (key === "space") input.pressKey(" ");
    else if (key === "up" || key === "down" || key === "left" || key === "right")
      input.pressArrow(key);
    else input.pressKey(key);
    // OpenTUI reports a lone Esc only after a timer rules out an escape sequence, so wait for the key itself.
    await received;
  }

  async function waitFor(
    match: FrameMatch,
    { timeout = WAIT_TIMEOUT }: { timeout?: number } = {},
  ): Promise<string> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const text = await frame();
      if (matches(text, match)) return text;
      if (Date.now() > deadline)
        throw new Error(
          `Timed out after ${timeout} ms waiting for ${describeMatch(match)}. Last frame:\n${text}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  function settled({ timeout }: { timeout?: number } = {}): Promise<string> {
    let seen = 0;
    return waitFor(
      function scanCompleteAndSized() {
        const snapshot = services.dashboard.getSnapshot();
        const done =
          snapshot.progress.phase === "complete" &&
          snapshot.rows.every(
            (row) => row.kind === "branch" || row.verdict === "Broken" || row.sizeKiB !== null,
          );
        seen = done ? seen + 1 : 0;
        return seen >= POLLS_TO_SHOW_SETTLED_FRAME;
      },
      { timeout },
    );
  }

  async function focus(branch: string): Promise<string> {
    let text = await frame();
    for (const direction of ["down", "up"])
      for (let step = 0; step < 50; step++) {
        if (focusedRow(text)?.split(" ")[1] === branch) return text;
        const before = focusedRow(text);
        await press(direction);
        text = await waitFor((next) => focusedRow(next) !== before, { timeout: 2000 }).catch(
          () => text,
        );
        if (focusedRow(text) === before) break;
      }
    throw new Error(`No list row for ${branch} could be focused. Last frame:\n${text}`);
  }

  return {
    sandbox,
    services,
    width,
    height,
    settled,
    size: (built) => sizeLabel(services.sizes.get(built.path!)?.sizeKiB ?? null),
    focus,
    press,
    async type(text) {
      for (const char of text) await press(char === " " ? "space" : char);
    },
    frame,
    waitFor,
    frames,
    async close() {
      if (closed) return;
      closed = true;
      try {
        setup.mockInput.pressCtrlC();
        await running;
      } finally {
        await services.close();
      }
    },
  };
}

/**
 * Runs `body` against a started app and always closes it. On failure, every distinct frame is saved under
 * the system temp folder and the error gains the last frame and that file's path.
 */
export async function withApp(
  sandbox: Sandbox,
  options: { width: number; height?: number; runner?: CommandRunner; name: string },
  body: (app: App) => Promise<void>,
): Promise<void> {
  const app = await startApp(sandbox, options);
  try {
    await body(app);
  } catch (error) {
    const last = await app.frame().catch(() => app.frames.at(-1) ?? "");
    const folder = join(tmpdir(), "wt-dash-e2e-frames");
    const file = join(folder, `${options.name.replaceAll(/[^\w.-]+/g, "-")}-${options.width}.txt`);
    await mkdir(folder, { recursive: true });
    await writeFile(file, app.frames.join(`\n${"═".repeat(options.width)}\n`));
    if (error instanceof Error)
      error.message += `\n\nLast frame (${options.width}x${app.height}):\n${last}\nAll ${app.frames.length} frames: ${file}`;
    throw error;
  } finally {
    await app.close();
  }
}

/** The text of the line holding `needle`, or "" when none does. */
export function lineWith(frame: string, needle: string | RegExp): string {
  return (
    frame
      .split("\n")
      .find((line) => (typeof needle === "string" ? line.includes(needle) : needle.test(line))) ??
    ""
  );
}

/** A line without the projects sidebar that wide layouts draw on its left. */
export function listPart(line: string): string {
  const edge = line.indexOf(" │ ");
  return edge >= 0 && edge < 40 ? line.slice(edge + 3) : line;
}

/** Runs of spaces squeezed to one, so column padding doesn't matter. */
export function squeeze(text: string): string {
  return text.replaceAll(/ {2,}/g, " ");
}

const escape = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ROW_MARKS = "□■–✓◦!✗?⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

function rowMatch(line: string, branch?: string): RegExpExecArray | null {
  const name = branch === undefined ? "\\S+" : escape(branch);
  return new RegExp(`(?:^|│ )(▌ |  )([${ROW_MARKS}]) (${name}) (.*)$`, "u").exec(line);
}

/**
 * A list row as `<mark> <branch> <rest>` with column padding squeezed, e.g. "□ feature/x merged  Its…".
 * The mark is □ (selectable), ■ (selected), – (blocked) or a removal status icon.
 */
export function rowOf(frame: string, branch: string): string | null {
  for (const line of frame.split("\n")) {
    const match = rowMatch(line, branch);
    if (match) return squeeze(`${match[2]} ${match[3]} ${match[4]}`).trimEnd();
  }
  return null;
}

/** The focused list row, as `rowOf` returns it, or null when no list row has focus. */
export function focusedRow(frame: string): string | null {
  for (const line of frame.split("\n")) {
    const match = rowMatch(line);
    if (match?.[1] === "▌ ") return squeeze(`${match[2]} ${match[3]} ${match[4]}`).trimEnd();
  }
  return null;
}

/** The verdict section a list row sits under, as its heading reads: "SAFE", "REVIEW", "BUSY" or "BROKEN". */
export function sectionOf(frame: string, branch: string): string | null {
  const lines = frame.split("\n");
  const index = lines.findIndex((line) => rowMatch(line, branch));
  for (let at = index - 1; index >= 0 && at >= 0; at--) {
    const heading = /(?:^|│ )[✓?‖✗] (SAFE|REVIEW|BUSY|BROKEN) /u.exec(lines[at]!);
    if (heading) return heading[1]!;
  }
  return null;
}

export const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Runs `body` in a fresh sandbox and always cleans it up. */
export async function inSandbox(body: (sandbox: Sandbox) => Promise<void>): Promise<void> {
  const sandbox = await createSandbox();
  try {
    await body(sandbox);
  } finally {
    await sandbox.cleanup();
  }
}

/** The entries of the sandbox's removals.log, oldest first. */
export async function removals(sandbox: Sandbox): Promise<Array<Record<string, unknown>>> {
  const log = await readFile(join(sandbox.cacheDir, "removals.log"), "utf8").catch(() => "");
  return log
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The confirmation dialog, from its title to its bottom edge, or "" when none is open. */
export function dialog(frame: string): string {
  const lines = frame.split("\n");
  const top = lines.findIndex((line) => line.includes("╭─"));
  const bottom = lines.findIndex((line) => line.includes("─╯"));
  return top < 0 ? "" : lines.slice(top, bottom + 1).join("\n");
}

/** The dialog's line for a row, squeezed: "• <branch> <repo> <size>", or "" when it isn't listed. */
export function dialogRow(frame: string, branch: string): string {
  const line = lineWith(frame, `│ • ${branch} `);
  return (
    line &&
    squeeze(line)
      .replace(/^.*?│ /, "")
      .replace(/ │.*$/, "")
  );
}
