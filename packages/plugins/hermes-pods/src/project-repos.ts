import { isRepoOriginAllowed } from '@manythreads/shared';
import type { PodConfig } from './render.ts';

/** A repository a team's project asks for on its pod: the project's name, its https address and the branch to check out. */
export interface ProjectRepo {
  name: string;
  origin: string;
  branch?: string;
}

/**
 * The chart's static repository list plus the team's projects. A project whose name the static list already holds is left out (the chart wins).
 * A project whose address is not plain or does not start with an allowed prefix (`repoOriginAllow`) is left out too: it is not cloned, and the pod's
 * list does not mention it, so nothing downstream can claim a copy that does not exist.
 */
export function withProjectRepos(cfg: PodConfig, projects: readonly ProjectRepo[]): PodConfig {
  if (projects.length === 0) return cfg;
  const taken = new Set(cfg.repos.map((r) => r.name));
  const extra = projects
    .filter((p) => !taken.has(p.name) && isRepoOriginAllowed(p.origin, cfg.repoOriginAllow))
    .map((p) => (p.branch ? { name: p.name, origin: p.origin, branch: p.branch } : { name: p.name, origin: p.origin }));
  return { ...cfg, repos: [...cfg.repos, ...extra] };
}
