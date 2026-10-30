import { join } from "node:path";
import { createActionService } from "./core/removal/service";
import type { ActionService } from "./core/removal/types";
import { createDashboardService } from "./core/scan/dashboard";
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
  /** Closes the dashboard, then saves and closes the size cache. */
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
}): Promise<Services> {
  const { home, sources, depth, wtPath, runner, readCreated, savedRepos } = options;
  const cache = join(home, ".cache/wt-dash");
  const sizes = createSizeService(join(cache, "sizes.json"), runner);
  await sizes.load();
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
      await sizes.close();
    },
  };
}
