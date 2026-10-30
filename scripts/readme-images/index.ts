/**
 * Rebuilds the README images in docs/images from the made-up projects in seed.ts: seeds a fresh verify-wt-dash
 * instance, drives the app in tmux to each screen, renders it with the stack's image command, and stops the
 * instance. macOS only, like the stack; needs tmux and agent-browser.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { NOW } from "./seed";

const root = resolve(import.meta.dir, "../..");
const stack = join(root, ".claude/skills/verify-wt-dash/stack.ts");
const out = join(root, "docs/images");
const name = "readme-images";
const TIMEOUT_MS = 10_000;

function bun(...args: string[]): Record<string, unknown> {
  const result = Bun.spawnSync([process.execPath, stack, ...args], {
    cwd: root,
    stderr: "inherit",
  });
  const parsed = JSON.parse(result.stdout.toString()) as Record<string, unknown>;
  if (parsed.ok !== true) throw new Error(`stack ${args[0]} failed: ${JSON.stringify(parsed)}`);
  return parsed;
}

let socket = "";
function tmux(...args: string[]): string {
  const result = Bun.spawnSync(["tmux", "-L", socket, ...args], { stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`tmux ${args.join(" ")} exited ${result.exitCode}`);
  return result.stdout.toString();
}
const screen = () => tmux("capture-pane", "-p", "-t", "app");
const press = (key: string) => tmux("send-keys", "-t", "app", key);

async function waitFor(test: (screen: string) => boolean, what: string): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < TIMEOUT_MS) {
    const text = screen();
    if (test(text)) return text;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}. Screen:\n${screen()}`);
}
const waitForText = (text: string) => waitFor((now) => now.includes(text), JSON.stringify(text));

async function settled() {
  let last = "";
  let since = Date.now();
  await waitFor((now) => {
    const header = now.split("\n")[0]!;
    if (header !== last || now.includes("sizing")) [last, since] = [header, Date.now()];
    return Date.now() - since >= 1000;
  }, "sizes to settle");
}

async function focus(branch: string, key: "Up" | "Down") {
  for (let step = 0; step < 30; step++) {
    if (screen().includes(`▌ □ ${branch} `)) return;
    press(key);
    await Bun.sleep(150);
  }
  throw new Error(`Could not focus ${branch}. Screen:\n${screen()}`);
}

function boxOf(text: string): { rows: string; cols: string } {
  const lines = text.split("\n");
  const top = lines.findIndex((line) => line.includes("╭"));
  const bottom = lines.findIndex((line) => line.includes("╯"));
  const line = lines[top]!;
  const left = Bun.stringWidth(line.slice(0, line.indexOf("╭"))) + 1;
  const right = Bun.stringWidth(line.slice(0, line.indexOf("╮"))) + 1;
  return { rows: `${top + 1}-${bottom + 1}`, cols: `${left}-${right}` };
}

const images: string[] = [];
async function image(file: string, crop: string[] = []) {
  const { png } = bun("image", "--name", name, "--out", `readme-${file}`, ...crop) as {
    png: string;
  };
  await copyFile(png, join(out, `${file}.png`));
  images.push(file);
}

// A signal skips `finally`, so stop the instance here too.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => {
    bun("down", "--name", name, "--purge");
    process.exit(130);
  });

try {
  await mkdir(out, { recursive: true });
  bun("down", "--name", name, "--purge");
  bun("up", "--name", name, "--seed", join(import.meta.dir, "seed.ts"), "--variant", "wide");
  socket = (bun("env", "--name", name).tmux as string).split(" ").at(-1)!;
  await settled();
  const clock = new Date(NOW).toISOString().slice(11, 16);
  if (!screen().includes(`scanned ${clock}`))
    throw new Error(`The app's clock isn't pinned to ${clock}; clock.ts did not load.`);

  press("Up");
  await waitForText("wt-dash › all projects");
  await waitForText("Orphaned 3");
  await image("projects");

  press("Down");
  await waitForText("wt-dash › storefront");
  press("Tab");
  await waitForText("space select");
  await focus("codex/cart-currency", "Down");
  await waitForText("~/.codex/worktrees/7c2e/storefront");
  await image("worktree-list");

  await focus("claude/image-zoom", "Up");
  press("a");
  await waitForText("■ claude/checkout-race");
  press("Space");
  await waitForText("■ claude/image-zoom");
  press("Enter");
  const dialog = await waitForText("Remove 4 worktrees and 1 branch");
  const box = boxOf(dialog);
  await image("remove-dialog", ["--rows", box.rows, "--cols", box.cols]);

  press("Escape");
  await waitFor((now) => !now.includes("esc cancels"), "the dialog to close");
  press("Escape");
  await waitForText("Cleared 5 selections");
  press("Left");
  await waitForText("→ worktrees");
  press("Up");
  await waitForText("wt-dash › all projects");
  bun("up", "--name", name, "--variant", "narrow");
  await waitForText("PROJECT            WORKTREES");
  await waitFor((now) => !now.includes("Cleared 5 selections"), "the toast to go");
  await image("projects-narrow");
} finally {
  bun("down", "--name", name, "--purge");
}

for (const file of images) {
  const hash = createHash("sha256")
    .update(await readFile(join(out, `${file}.png`)))
    .digest("hex");
  console.log(`docs/images/${file}.png  ${hash.slice(0, 16)}`);
}
