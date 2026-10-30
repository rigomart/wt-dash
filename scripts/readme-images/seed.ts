/**
 * The made-up world the README images show: four projects under `~/code` in the sandbox's own home folder, with
 * worktrees in the folders Claude Code, Codex, Cursor and t3 use, sized with APFS clones of a small pool file so
 * `du` reports gigabytes without writing them. Every date is fixed relative to NOW, and the app's clock is pinned
 * to NOW by clock.ts, so a rebuild makes the same commits and the same screens.
 */
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { SeedModule, SeedRow } from "../../.claude/skills/verify-wt-dash/stack";

/** The time every image shows; clock.ts starts the app's clock here. */
export const NOW = "2026-10-27T15:42:00Z";
const now = Date.parse(NOW);

type Tool = "claude" | "codex" | "cursor" | "t3";
type Ago = `${number}${"m" | "h" | "d"}`;

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const at = (ago: Ago) => now - Number(ago.slice(0, -1)) * UNIT_MS[ago.at(-1) as "m" | "h" | "d"];

const identity = {
  GIT_AUTHOR_NAME: "Sam Rivera",
  GIT_AUTHOR_EMAIL: "sam@example.com",
  GIT_COMMITTER_NAME: "Sam Rivera",
  GIT_COMMITTER_EMAIL: "sam@example.com",
};
const dated = (time: number) => {
  const date = `@${Math.floor(time / 1000)} +0000`;
  return { ...identity, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
};

const PACKAGES = [
  "next",
  "@swc/core-darwin-arm64",
  "typescript",
  "esbuild",
  "@img/sharp-darwin-arm64",
  "react-dom",
  "@babel/core",
  "prettier",
];
const MIB = 1024 * 1024;
const CHUNKS = [16 * MIB, MIB, 64 * 1024];

const source = (subject: string, lines: number) =>
  Array.from({ length: lines }, (_, index) => `// ${subject}: step ${index + 1}`).join("\n") + "\n";

interface Commit {
  at: Ago;
  subject: string;
  file: string;
  lines: number;
}

type Expected = Pick<SeedRow, "verdict" | "status" | "reason"> & { blocked?: boolean };

interface WorktreeSpec {
  branch: string;
  tool: Tool;
  /** The agent's folder name for it: Codex's and Cursor's id, Claude Code's and t3's name. */
  folder: string;
  created: Ago;
  commits?: Commit[];
  merged?: { at: Ago; squashAs?: string };
  sizeMiB?: number;
}

const seed: SeedModule = async (sandbox) => {
  const home = sandbox.home;
  const code = join(home, "code");
  const pool = join(sandbox.root, "pool");
  await mkdir(pool);
  await mkdir(code);
  for (const [index, bytes] of CHUNKS.entries())
    await writeFile(join(pool, `${index}.bin`), randomBytes(bytes));
  const rows: SeedRow[] = [];

  async function run(cwd: string, env: Record<string, string>, command: string, args: string[]) {
    const result = await sandbox.exec(command, args, { cwd, env });
    if (result.exitCode !== 0)
      throw new Error(`${command} ${args.join(" ")} exited ${result.exitCode}: ${result.stderr}`);
    return result.stdout.trim();
  }
  const git = (cwd: string, time: number, ...args: string[]) => run(cwd, dated(time), "git", args);

  async function fill(folder: string, mib: number, nextCache = false) {
    let left = Math.round(mib * MIB);
    let index = 0;
    for (const [chunk, bytes] of CHUNKS.entries())
      for (; left >= bytes; left -= bytes, index++) {
        const inCache = nextCache && index % 7 === 6;
        const dir = inCache
          ? join(folder, ".next", "cache", "webpack")
          : join(folder, "node_modules", PACKAGES[index % PACKAGES.length]!);
        await mkdir(dir, { recursive: true });
        await copyFile(
          join(pool, `${chunk}.bin`),
          join(dir, `${index}.bin`),
          constants.COPYFILE_FICLONE,
        );
      }
  }

  async function backdate(worktree: string, time: number) {
    const gitdir = /^gitdir: (.+)$/m.exec(await readFile(join(worktree, ".git"), "utf8"))![1]!;
    await utimes(resolve(worktree, gitdir.trim()), new Date(time), new Date(time));
  }

  async function project(name: string, history: Array<[Ago, string, string]>) {
    const path = join(code, name);
    const start = at(history[0]![0]);
    await git(code, start, "init", "-q", path);
    await writeFile(join(path, "README.md"), `# ${name}\n`);
    await writeFile(
      join(path, ".gitignore"),
      "node_modules/\n.next/\ndist/\n.env.local\n.claude/worktrees/\n",
    );
    await writeFile(join(path, "package.json"), `{ "name": "${name}", "private": true }\n`);
    await git(path, start, "add", ".");
    await git(path, start, "commit", "-q", "-m", history[0]![1]);
    for (const [ago, subject, file] of history.slice(1)) await commit(path, ago, subject, file, 12);

    const folderFor = (tool: Tool, folder: string) =>
      ({
        claude: join(path, ".claude", "worktrees", folder),
        codex: join(home, ".codex", "worktrees", folder, name),
        cursor: join(home, ".cursor", "worktrees", name, folder),
        t3: join(home, ".t3", "worktrees", name, folder),
      })[tool];

    async function commit(cwd: string, ago: Ago, subject: string, file: string, lines: number) {
      await mkdir(dirname(join(cwd, file)), { recursive: true });
      await writeFile(join(cwd, file), source(subject, lines));
      await git(cwd, at(ago), "add", file);
      await git(cwd, at(ago), "commit", "-q", "-m", subject);
    }

    async function worktree(spec: WorktreeSpec, expected: Expected | null) {
      const folder = folderFor(spec.tool, spec.folder);
      await mkdir(dirname(folder), { recursive: true });
      const created = at(spec.created);
      await git(path, created, "worktree", "add", "-q", "-b", spec.branch, folder, "main");
      if (spec.tool === "codex")
        await writeFile(join(dirname(folder), ".codex-worktree-name"), `${spec.branch}\n`);
      for (const step of spec.commits ?? [])
        await commit(folder, step.at, step.subject, step.file, step.lines);
      if (spec.merged) {
        const time = at(spec.merged.at);
        if (spec.merged.squashAs) {
          await git(path, time, "merge", "-q", "--squash", spec.branch);
          await git(path, time, "commit", "-q", "-m", spec.merged.squashAs);
        } else
          await git(
            path,
            time,
            "merge",
            "-q",
            "--no-ff",
            "-m",
            `Merge branch '${spec.branch}'`,
            spec.branch,
          );
      }
      if (spec.sizeMiB) await fill(folder, spec.sizeMiB, name === "storefront");
      await backdate(folder, created);
      if (expected)
        rows.push({
          repo: name,
          kind: "worktree",
          branch: spec.branch,
          path: folder,
          blocked: false,
          ...expected,
        });
      return folder;
    }

    async function leftover(
      branch: string,
      created: Ago,
      commits: Commit[],
      merged: Ago | null,
      expected: Expected,
    ) {
      const folder = join(sandbox.root, "worktrees", `${name}.${branch.replaceAll("/", "-")}`);
      await git(path, at(created), "worktree", "add", "-q", "-b", branch, folder, "main");
      for (const step of commits)
        await commit(folder, step.at, step.subject, step.file, step.lines);
      await git(path, at(commits.at(-1)!.at), "worktree", "remove", folder);
      if (merged)
        await git(
          path,
          at(merged),
          "merge",
          "-q",
          "--no-ff",
          "-m",
          `Merge branch '${branch}'`,
          branch,
        );
      rows.push({ repo: name, kind: "branch", branch, path: null, blocked: false, ...expected });
    }

    return { name, path, folderFor, commit, worktree, leftover };
  }

  const squashSafe = {
    verdict: "Safe",
    status: "merged",
    reason: "Merging it into main would change nothing.",
  };
  const mergedSafe = {
    verdict: "Safe",
    status: "merged",
    reason: "Its commits are already in main.",
  };

  const storefront = await project("storefront", [
    ["40d", "Initial commit", ""],
    ["38d", "Add product listing page", "app/products/page.tsx"],
    ["30d", "Add cart drawer", "components/cart-drawer.tsx"],
    ["21d", "Move checkout to server actions", "app/checkout/actions.ts"],
    ["16d", "Add search route", "app/search/route.ts"],
  ]);
  await storefront.worktree(
    {
      branch: "claude/legacy-coupons",
      tool: "claude",
      folder: "legacy-coupons",
      created: "14d",
      commits: [
        {
          at: "13d",
          subject: "Remove the legacy coupon service",
          file: "lib/coupons.ts",
          lines: 9,
        },
      ],
      merged: { at: "12d", squashAs: "Remove the legacy coupon service (#188)" },
      sizeMiB: 1162.4,
    },
    squashSafe,
  );
  await storefront.leftover(
    "fix/tax-rounding",
    "11d",
    [
      {
        at: "11d",
        subject: "Round tax per line item, not per order",
        file: "lib/tax.ts",
        lines: 14,
      },
    ],
    "10d",
    mergedSafe,
  );
  await storefront.worktree(
    {
      branch: "codex/add-gift-cards",
      tool: "codex",
      folder: "a1f3",
      created: "9d",
      commits: [
        {
          at: "9d",
          subject: "Add gift card balance lookup",
          file: "app/gift-cards/balance.ts",
          lines: 31,
        },
        {
          at: "8d",
          subject: "Apply gift cards at checkout",
          file: "app/checkout/gift-cards.ts",
          lines: 22,
        },
      ],
      merged: { at: "6d" },
      sizeMiB: 1271.8,
    },
    mergedSafe,
  );
  const checkoutRace = await storefront.worktree(
    {
      branch: "claude/checkout-race",
      tool: "claude",
      folder: "checkout-race",
      created: "5d",
      commits: [
        {
          at: "5d",
          subject: "Lock the cart while an order is submitted",
          file: "app/checkout/lock.ts",
          lines: 18,
        },
        {
          at: "4d",
          subject: "Retry the payment intent once on conflict",
          file: "app/checkout/retry.ts",
          lines: 11,
        },
      ],
      merged: { at: "4d", squashAs: "Fix checkout race when two tabs submit (#212)" },
      sizeMiB: 1243.6,
    },
    squashSafe,
  );
  await writeFile(join(checkoutRace, ".env.local"), "STRIPE_SECRET_KEY=sk_test_placeholder\n");
  const zoom = await storefront.worktree(
    {
      branch: "claude/image-zoom",
      tool: "claude",
      folder: "image-zoom",
      created: "3d",
      commits: [
        {
          at: "3d",
          subject: "Add pinch zoom to the product gallery",
          file: "components/gallery-zoom.tsx",
          lines: 47,
        },
      ],
      sizeMiB: 1308.3,
    },
    {
      verdict: "Review",
      status: "uncommitted changes",
      reason: "Removing it deletes work that isn't committed.",
    },
  );
  await writeFile(
    join(zoom, "components", "gallery-zoom.tsx"),
    source("Add pinch zoom, with momentum", 52),
  );
  await writeFile(join(zoom, "components", "gallery-zoom.test.tsx"), source("Zoom tests", 20));
  await storefront.worktree(
    {
      branch: "codex/cart-currency",
      tool: "codex",
      folder: "7c2e",
      created: "2d",
      commits: [
        {
          at: "2d",
          subject: "Format cart totals in the shopper's currency",
          file: "lib/currency.ts",
          lines: 26,
        },
        { at: "1d", subject: "Cache exchange rates for an hour", file: "lib/rates.ts", lines: 19 },
      ],
      sizeMiB: 1224.9,
    },
    { verdict: "Review", status: "unmerged commits", reason: "2 commits aren't in main." },
  );
  const search = await storefront.worktree(
    {
      branch: "t3/search-autocomplete",
      tool: "t3",
      folder: "t3-search-autocomplete",
      created: "2d",
      commits: [
        {
          at: "1d",
          subject: "Suggest products as the shopper types",
          file: "app/search/route.ts",
          lines: 24,
        },
      ],
      sizeMiB: 1289.2,
    },
    {
      verdict: "Busy",
      status: "rebase in progress",
      reason: "A rebase was started here and isn't finished.",
      blocked: true,
    },
  );
  await storefront.commit(
    storefront.path,
    "20h",
    "Rank search results by sales",
    "app/search/route.ts",
    16,
  );
  const rebase = await git(search, at("5h"), "rebase", "main").catch(() => "stopped");
  if (rebase !== "stopped") throw new Error("t3/search-autocomplete rebased without a conflict");
  const pagination = await storefront.worktree(
    {
      branch: "claude/order-paging",
      tool: "claude",
      folder: "order-paging",
      created: "6h",
      commits: [
        {
          at: "5h",
          subject: "Paginate the order history",
          file: "app/account/orders/page.tsx",
          lines: 33,
        },
      ],
      merged: { at: "3h", squashAs: "Paginate the order history (#219)" },
      sizeMiB: 1187.5,
    },
    { verdict: "Review", status: "merged", reason: "An agent was working here 20m ago." },
  );
  await run(
    pagination,
    { WORKTRUNK_TEST_EPOCH: String(Math.floor(at("20m") / 1000)) },
    sandbox.wtPath,
    ["config", "state", "marker", "set", "🤖"],
  );
  await storefront.leftover(
    "spike/edge-rendering",
    "26d",
    [
      {
        at: "25d",
        subject: "Try rendering product pages at the edge",
        file: "app/products/edge.tsx",
        lines: 40,
      },
    ],
    null,
    { verdict: "Review", status: "unmerged commits", reason: "1 commit isn't in main." },
  );
  const stale = storefront.folderFor("t3", "t3-banner");
  await mkdir(dirname(stale), { recursive: true });
  await git(storefront.path, at("19d"), "worktree", "add", "-q", "-b", "t3/banner", stale, "main");
  await fill(stale, 1205.7, true);
  await rename(stale, `${stale}.moved`);
  await git(storefront.path, at("18d"), "worktree", "prune");
  await rename(`${stale}.moved`, stale);
  await git(storefront.path, at("18d"), "branch", "-D", "t3/banner");
  rows.push({
    repo: "Orphaned folders",
    kind: "orphan",
    branch: "storefront/t3-banner",
    path: stale,
    verdict: "Orphaned",
    status: "unknown to its repo",
    reason: "Its repository at ~/code/storefront no longer lists it.",
    blocked: false,
  });

  const billing = await project("billing-api", [
    ["60d", "Initial commit", ""],
    ["55d", "Add invoice model", "src/invoices/model.ts"],
    ["33d", "Add Stripe webhook handler", "src/webhooks/stripe.ts"],
    ["18d", "Bill usage per seat", "src/billing/seats.ts"],
  ]);
  await billing.worktree(
    {
      branch: "codex/retry-webhooks",
      tool: "codex",
      folder: "c08d",
      created: "8d",
      commits: [
        {
          at: "8d",
          subject: "Retry failed webhooks with backoff",
          file: "src/webhooks/retry.ts",
          lines: 28,
        },
      ],
      merged: { at: "7d", squashAs: "Retry failed webhooks with backoff (#97)" },
      sizeMiB: 412.6,
    },
    squashSafe,
  );
  await billing.leftover(
    "codex/idempotency-keys",
    "16d",
    [
      {
        at: "16d",
        subject: "Require idempotency keys on POST /charges",
        file: "src/charges/idempotency.ts",
        lines: 21,
      },
    ],
    "15d",
    mergedSafe,
  );
  await billing.worktree(
    {
      branch: "claude/proration-fix",
      tool: "claude",
      folder: "proration-fix",
      created: "4d",
      commits: [
        {
          at: "4d",
          subject: "Round prorations to the cent",
          file: "src/billing/proration.ts",
          lines: 8,
        },
      ],
      merged: { at: "3d" },
      sizeMiB: 386.1,
    },
    mergedSafe,
  );
  await billing.worktree(
    {
      branch: "claude/invoice-pdf",
      tool: "claude",
      folder: "invoice-pdf",
      created: "2d",
      commits: [
        { at: "2d", subject: "Export invoices as PDF", file: "src/invoices/pdf.ts", lines: 64 },
      ],
      sizeMiB: 431.4,
    },
    { verdict: "Review", status: "locked", reason: "Locked: Claude Code session", blocked: true },
  );
  await git(
    billing.path,
    at("2d"),
    "worktree",
    "lock",
    "--reason",
    "Claude Code session",
    billing.folderFor("claude", "invoice-pdf"),
  );
  const conflicts = await billing.worktree(
    {
      branch: "t3/stripe-sdk-v17",
      tool: "t3",
      folder: "t3-stripe-sdk-v17",
      created: "3d",
      commits: [
        {
          at: "3d",
          subject: "Upgrade the Stripe SDK to v17",
          file: "src/webhooks/stripe.ts",
          lines: 15,
        },
      ],
      sizeMiB: 447.3,
    },
    {
      verdict: "Busy",
      status: "unresolved conflicts",
      reason: "Some files still have merge conflicts.",
      blocked: true,
    },
  );
  await billing.commit(
    billing.path,
    "2d",
    "Verify webhook signatures",
    "src/webhooks/stripe.ts",
    10,
  );
  const merge = await sandbox.exec("git", ["merge", "main"], {
    cwd: conflicts,
    env: dated(at("1d")),
  });
  if (merge.exitCode === 0) throw new Error("t3/stripe-sdk-v17 merged main without a conflict");
  await git(conflicts, at("1d"), "merge", "--quit");
  const remote = join(sandbox.root, "remotes", "billing-api.git");
  await git(sandbox.root, now, "init", "-q", "--bare", remote);
  await git(billing.path, now, "remote", "add", "origin", remote);
  const limiter = await billing.worktree(
    {
      branch: "codex/add-rate-limiter",
      tool: "codex",
      folder: "e51b",
      created: "1d",
      commits: [
        {
          at: "22h",
          subject: "Add a token bucket rate limiter",
          file: "src/middleware/rate-limit.ts",
          lines: 37,
        },
      ],
      sizeMiB: 368.2,
    },
    { verdict: "Review", status: "unpushed commits", reason: "1 commit isn't pushed." },
  );
  await git(limiter, at("21h"), "push", "-q", "-u", "origin", "codex/add-rate-limiter");
  await billing.commit(
    limiter,
    "19h",
    "Document the per-IP rate limits",
    "docs/rate-limits.md",
    16,
  );

  const mobile = await project("mobile-app", [
    ["90d", "Initial commit", ""],
    ["70d", "Add tab navigation", "src/navigation/tabs.tsx"],
    ["24d", "Add settings screen", "src/screens/settings.tsx"],
  ]);
  await mobile.worktree(
    {
      branch: "cursor/onboarding",
      tool: "cursor",
      folder: "k3p2",
      created: "20d",
      commits: [
        {
          at: "20d",
          subject: "Add the onboarding carousel",
          file: "src/screens/onboarding.tsx",
          lines: 58,
        },
      ],
      merged: { at: "17d", squashAs: "Add the onboarding carousel (#341)" },
      sizeMiB: 2351.7,
    },
    squashSafe,
  );
  await mobile.worktree(
    {
      branch: "t3/dark-mode-tokens",
      tool: "t3",
      folder: "t3-dark-mode-tokens",
      created: "7d",
      commits: [
        {
          at: "7d",
          subject: "Read colors from the theme tokens",
          file: "src/theme/colors.ts",
          lines: 23,
        },
      ],
      merged: { at: "5d", squashAs: "Read colors from the theme tokens (#352)" },
      sizeMiB: 2408.9,
    },
    squashSafe,
  );
  const offline = await mobile.worktree(
    {
      branch: "codex/offline-sync",
      tool: "codex",
      folder: "9a4f",
      created: "12d",
      commits: [
        { at: "12d", subject: "Queue writes while offline", file: "src/sync/queue.ts", lines: 44 },
      ],
    },
    {
      verdict: "Broken",
      status: "folder missing",
      reason: "The folder is gone, but Git still lists the worktree.",
      blocked: true,
    },
  );
  await rm(dirname(offline), { recursive: true });
  // The newest worktree starts from this commit, so its age column agrees with "Created 2h ago". It is empty so
  // main's files stay the same and t3/dark-mode-tokens still matches main exactly.
  await git(mobile.path, at("2h"), "commit", "-q", "--allow-empty", "-m", "Release 1.4.2");
  await mobile.worktree(
    {
      branch: "claude/push-settings",
      tool: "claude",
      folder: "push-settings",
      created: "2h",
      sizeMiB: 2276.4,
    },
    {
      verdict: "Review",
      status: "no new commits",
      reason: "Created 2h ago, so it may still be in use.",
    },
  );

  const design = await project("design-system", [
    ["120d", "Initial commit", ""],
    ["80d", "Add Button and Input", "src/button.tsx"],
    ["29d", "Publish tokens as CSS variables", "src/tokens.css"],
  ]);
  await design.worktree(
    {
      branch: "claude/focus-ring",
      tool: "claude",
      folder: "focus-ring",
      created: "10d",
      commits: [
        {
          at: "10d",
          subject: "Show a focus ring on keyboard focus only",
          file: "src/button.tsx",
          lines: 12,
        },
      ],
      merged: { at: "9d", squashAs: "Show a focus ring on keyboard focus only (#64)" },
      sizeMiB: 718.3,
    },
    squashSafe,
  );
  await design.worktree(
    {
      branch: "t3/docs-site-search",
      tool: "t3",
      folder: "t3-docs-site-search",
      created: "6d",
      commits: [
        { at: "6d", subject: "Add search to the docs site", file: "docs/search.ts", lines: 35 },
      ],
      merged: { at: "6d" },
      sizeMiB: 755.2,
    },
    mergedSafe,
  );
  await design.worktree(
    {
      branch: "cursor/tokens-v2",
      tool: "cursor",
      folder: "r7wd",
      created: "4d",
      commits: [
        {
          at: "4d",
          subject: "Rename color tokens to the v2 scheme",
          file: "src/tokens.css",
          lines: 41,
        },
        {
          at: "3d",
          subject: "Add a codemod for the token rename",
          file: "codemods/tokens-v2.ts",
          lines: 27,
        },
        { at: "2d", subject: "Keep the v1 names as aliases", file: "src/tokens-v1.css", lines: 18 },
      ],
      sizeMiB: 693.8,
    },
    { verdict: "Review", status: "unmerged commits", reason: "3 commits aren't in main." },
  );

  const gone = await project("checkout-v1", [["200d", "Initial commit", ""]]);
  const old = await gone.worktree(
    {
      branch: "codex/legacy-paypal",
      tool: "codex",
      folder: "e94b",
      created: "45d",
      sizeMiB: 981.6,
    },
    null,
  );
  rows.push({
    repo: "Orphaned folders",
    kind: "orphan",
    branch: "e94b/checkout-v1",
    path: old,
    verdict: "Orphaned",
    status: "repository gone",
    reason: "Its repository at ~/code/checkout-v1 no longer exists.",
    blocked: false,
  });
  await rm(gone.path, { recursive: true });
  const shell = join(home, ".codex", "worktrees", "3d9e");
  await mkdir(shell, { recursive: true });
  await writeFile(join(shell, ".codex-worktree-name"), "codex/apple-pay\n");
  rows.push({
    repo: "Orphaned folders",
    kind: "orphan",
    branch: "3d9e",
    path: shell,
    verdict: "Orphaned",
    status: "no worktree inside",
    reason: "Codex left this folder behind with no worktree inside.",
    blocked: false,
  });

  return {
    rows,
    scanRoot: code,
    env: {
      TZ: "UTC",
      WT_DASH_README_NOW: NOW,
      // Bun splits BUN_OPTIONS on spaces and ignores quotes, but keeps a backslash-escaped space.
      BUN_OPTIONS: `--preload ${join(import.meta.dir, "clock.ts").replaceAll(" ", "\\ ")}`,
    },
  };
};

export default seed;
