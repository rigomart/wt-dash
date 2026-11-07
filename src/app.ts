import { join } from "node:path";
import { createProofCache } from "./core/github/cache";
import { createGitHubCheck, type GitHubOptions } from "./core/github/check";
import { createActionService } from "./core/removal/service";
import type { ActionService } from "./core/removal/types";
import { createDashboardService, type FollowUp } from "./core/scan/dashboard";
import { findRepos, type RepoSource } from "./core/scan/discovery";
import { findProcesses } from "./core/processes";
import { findOrphans } from "./core/scan/orphans";
import { rememberRepos } from "./core/scan/saved";
import { createSizeService } from "./core/sizes";
import type { CommandRunner, DashboardService, SizeService } from "./core/types";

export interface Services {
  dashboard: DashboardService;
  actions: ActionService;
  sizes: SizeService;
  /** Closes the dashboard, then saves and closes the size and pull request caches. */
  close(): Promise<void>;
}

export async function createServices(options: {
  home: string;
  sources: RepoSource[];
  depth: number;
  wtPath: string;
  runner: CommandRunner;
  readCreated?: (worktree: string) => Promise<string | null>;
  /** Saves each scan's repositories to `file`, and with `listed` (a run without folders) lists the saved ones too. */
  savedRepos?: { file: string; listed: boolean };
  /** How rows Git can't prove merged are checked against GitHub; offline when omitted. */
  github?: GitHubOptions;
  /** Runs after each repository's listing in place of the GitHub check. */
  followUp?: FollowUp;
}): Promise<Services> {
  const { home, sources, depth, wtPath, runner, readCreated, savedRepos } = options;
  const cache = join(home, ".cache/wt-dash");
  const sizes = createSizeService(join(cache, "sizes.json"), runner);
  const proofs = createProofCache(join(cache, "pull-requests.json"));
  await Promise.all([sizes.load(), proofs.load()]);
  const dashboard = createDashboardService({
    projectRoot: home,
    wtPath,
    runner,
    sizeService: sizes,
    discover: async () => {
      const found = [
        ...new Set((await findRepos(sources, depth)).flatMap(({ repos }) => repos)),
      ].sort();
      if (!savedRepos) return found;
      const saved = await rememberRepos(savedRepos.file, found);
      return savedRepos.listed ? saved : found;
    },
    readCreated,
    findOrphans: (repos) => findOrphans(home, repos),
    findProcesses: (paths, signal) => findProcesses(paths, runner, { signal }),
    followUp:
      options.followUp ??
      createGitHubCheck({
        github: options.github ?? { offline: true, ghPath: null },
        runner,
        proofs,
      }),
  });
  const actions = createActionService({
    wtPath,
    runner,
    logPath: join(cache, "removals.log"),
    readCreated,
  });
  return {
    dashboard,
    actions,
    sizes,
    async close() {
      await dashboard.close();
      await Promise.all([sizes.close(), proofs.close()]);
    },
  };
}
