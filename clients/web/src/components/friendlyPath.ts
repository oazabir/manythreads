/*
 * Plain names for the team repo's own folders and files (P21-13). A person reads "Bots", "Jobs" and "Team file", never `bots/`, `routines/`
 * or `TEAM.md`; the real path stays in a tooltip (and in data attributes for tests). Only names the platform owns are mapped, so a page
 * a person called `bots` further down keeps its own name.
 */

const TOP_FOLDERS: Readonly<Record<string, string>> = {
  apps: 'Apps',
  bots: 'Bots',
  channels: 'Channels',
  inbox: 'Inbox',
  knowledge: 'Knowledge',
  memory: 'Memory',
  pages: 'Pages',
  routines: 'Jobs',
  skills: 'Skills',
};

const PLATFORM_FILES: Readonly<Record<string, string>> = {
  'TEAM.md': 'Team file',
  'BOT.md': 'Bot file',
  'SKILL.md': 'Skill file',
};

/** The name of one row: a top-level platform folder or a platform file gets its plain name, anything else its own. */
export function friendlyName(path: string, name: string): string {
  if (!path.includes('/') && TOP_FOLDERS[name]) return TOP_FOLDERS[name];
  return PLATFORM_FILES[name] ?? name;
}

/** A whole path in plain words: `routines/weekly.yaml` reads `Jobs › weekly.yaml`; the empty path is the top folder. */
export function friendlyPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return 'Top folder';
  return parts.map((p, i) => (i === 0 && parts.length > 0 && TOP_FOLDERS[p] ? TOP_FOLDERS[p] : (PLATFORM_FILES[p] ?? p))).join(' › ');
}
