import { REPO_LAYOUT_DIRS, REPO_PLACEHOLDER, REPO_TEAM_FILE, parseRepoPath } from '@manythreads/shared';

/** The TEAM.md of a team that has neither pending files nor a template: its name and nothing else (SPEC section 5.1: manifest). */
export function defaultTeamMd(name: string, slug: string): string {
  const quote = (s: string): string => JSON.stringify(s);
  return `---\nname: ${quote(name)}\nslug: ${quote(slug)}\n---\n\n# ${name.replace(/[\r\n]+/g, ' ')}\n`;
}

export interface TeamSeed {
  name: string;
  slug: string;
  templateTeamMd: string | null;
  /** The files team creation parked in `team_pending_files` (null when none, or already applied). */
  pending: Record<string, unknown> | null;
}

/**
 * The first commit's files (SPEC section 5.1): TEAM.md (the pending one, else the template's copy, else a minimal manifest), any other
 * pending file that is a valid path, and a `.gitkeep` in every folder of the layout that would otherwise be empty
 * (git holds no empty folder). Returns path -> text.
 */
export function initialFiles(seed: TeamSeed): Map<string, string> {
  const files = new Map<string, string>();
  const pending = seed.pending ?? {};
  for (const [rawPath, content] of Object.entries(pending)) {
    if (typeof content !== 'string') continue;
    const parsed = parseRepoPath(rawPath);
    if (parsed.ok) files.set(parsed.path, content);
  }
  if (!files.has(REPO_TEAM_FILE)) files.set(REPO_TEAM_FILE, seed.templateTeamMd ?? defaultTeamMd(seed.name, seed.slug));
  for (const dir of REPO_LAYOUT_DIRS) {
    const holdsFile = [...files.keys()].some((p) => p.startsWith(`${dir}/`));
    if (!holdsFile) files.set(`${dir}/${REPO_PLACEHOLDER}`, '');
  }
  return files;
}
