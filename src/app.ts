import { join } from "node:path";
import { createActionService } from "./core/removal/service";
import type { ActionService } from "./core/removal/types";
import { createDashboardService } from "./core/scan/dashboard";
import { discoverRepos } from "./core/scan/discovery";
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
  roots: string[];
  depth: number;
  wtPath: string;
  runner: CommandRunner;
  readCreated?: (worktree: string) => Promise<string | null>;
}): Promise<Services> {
  const { home, roots, depth, wtPath, runner, readCreated } = options;
  const cache = join(home, ".cache/wt-dash");
  const sizes = createSizeService(join(cache, "sizes.json"), runner);
  await sizes.load();
  const dashboard = createDashboardService({
    projectRoot: roots[0]!,
    wtPath,
    runner,
    sizeService: sizes,
    discover: async () =>
      [
        ...new Set((await Promise.all(roots.map((root) => discoverRepos(root, depth + 1)))).flat()),
      ].sort(),
    readCreated,
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
