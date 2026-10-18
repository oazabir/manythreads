import { OKF_VERSION, serializeConcept, type OkfFrontmatter } from './concept.ts';

// The two files the platform keeps at the root of a team's memory bundle (SPEC §12.1, §5.1): `memory/index.md` (frontmatter `okf_version: "0.2"`
// and nothing else) and `memory/log.md` (date-grouped, newest first). P5-14 writes each ONCE, when a team's memory is first used; P5-25 makes the
// repo writer regenerate them (and every directory's `index.md`) deterministically in the same commit as a change, and P5-24's `OkfIndex` /
// `OkfLog` take these two renderers over. Pure: no clock, no database, no model — the same tree always renders the same bytes (PLAN criterion 18).

/** The heading under which a directory `index.md` lists its child folders (OKF §8: an index enumerates files *and* subdirectories). */
export const BUNDLE_FOLDERS_SECTION = 'Folders';

/** The intro a person reads at the root of an otherwise empty bundle; the root's body is this, then the directory's sections. */
const BUNDLE_INDEX_INTRO = [
  '# Team memory',
  '',
  "This folder is the team's memory: an OKF bundle (one Markdown file per concept, YAML frontmatter with a `type`).",
  'People edit it like any file; the platform indexes each concept for recall and keeps this file and `log.md`.',
].join('\n');

/** `memory/index.md`: the bundle root — `okf_version: "0.2"` and nothing else in the frontmatter, then the intro and the root's own entries. */
export function renderBundleIndex(entries: readonly OkfIndexEntry[] = []): string {
  const body = entries.length === 0 ? BUNDLE_INDEX_INTRO : `${BUNDLE_INDEX_INTRO}\n\n${renderIndexEntries(entries)}`;
  return serializeConcept({ okf_version: OKF_VERSION }, body);
}

/** One entry of a directory `index.md` (OKF §8): a heading section, a link to a concept, and its description. */
export interface OkfIndexEntry {
  section: string;
  path: string;
  title: string;
  description: string;
}

/** A directory index: sections in order, entries in order. */
export interface OkfIndex {
  sections: readonly string[];
  entries: readonly OkfIndexEntry[];
}

/** Parse a directory `index.md`: `#` headings open sections, `* [title](path) - description` bullets are entries. Never throws. */
export function parseIndex(content: string): OkfIndex {
  const sections: string[] = [];
  const entries: OkfIndexEntry[] = [];
  let section = '';
  for (const raw of content.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const head = /^#{1,6}\s+(.*?)\s*$/.exec(line)?.[1]?.trim() ?? null;
    if (head !== null && head !== '') {
      section = head;
      if (!sections.includes(section)) sections.push(section);
      continue;
    }
    const item = /^[*\-+]\s+\[([^\]]+)\]\(([^)]+)\)\s*(?:-\s*(.*))?$/.exec(line.trim());
    if (item) {
      entries.push({ section, path: item[2]?.trim() ?? '', title: item[1]?.trim() ?? '', description: (item[3] ?? '').trim() });
    }
  }
  return { sections, entries };
}

/** Render a directory `index.md` deterministically: `# <section>` groups in given order, one bullet per entry. */
export function renderIndex(index: OkfIndex): string {
  const lines: string[] = [];
  const order = index.sections.length > 0 ? [...index.sections] : [...new Set(index.entries.map((e) => e.section))];
  for (const section of order) {
    if (section !== '') lines.push(`# ${section}`, '');
    for (const entry of index.entries) {
      if (entry.section !== section) continue;
      const tail = entry.description === '' ? '' : ` - ${entry.description}`;
      lines.push(`* [${entry.title}](${entry.path})${tail}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export type OkfLogEntry = BundleLogEntry;
export type OkfLog = readonly OkfLogEntry[];

/** Parse a `log.md` (OKF §9): `## YYYY-MM-DD` headings open date groups (newest first), `-` bullets are entries. Never throws. */
export function parseLog(content: string): OkfLog {
  const entries: BundleLogEntry[] = [];
  let date = '';
  for (const raw of content.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const head = /^#{2,6}\s+(\d{4}-\d{2}-\d{2})\s*$/.exec(line.trim())?.[1];
    if (head !== undefined) {
      date = head;
      continue;
    }
    const bullet = /^[*\-+]\s+(.*?)\s*$/.exec(line.trim())?.[1];
    if (bullet !== undefined && bullet !== '' && date !== '') entries.push({ date, text: bullet });
  }
  return entries;
}

/** Render a `log.md` deterministically (same shape as `renderBundleLog`, without the `# Memory log` title requirement). */
export function renderLog(entries: OkfLog): string {
  return renderBundleLog(entries);
}

/** One dated entry of `memory/log.md` (`date` is `YYYY-MM-DD`). */
export interface BundleLogEntry {
  date: string;
  text: string;
}

/** `memory/log.md`: `## <date>` groups, newest first, one bullet per entry (entries of one date keep their given order). */
export function renderBundleLog(entries: readonly BundleLogEntry[]): string {
  const dates = [...new Set(entries.map((e) => e.date))].sort().reverse();
  const lines: string[] = ['# Memory log', ''];
  for (const date of dates) {
    lines.push(`## ${date}`, '');
    for (const entry of entries) if (entry.date === date) lines.push(`- ${entry.text.replace(/\s+/g, ' ').trim()}`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

// ---- the bundle as a pure function of its tree (P5-25) --------------------------------------------------------------------------

/** The section order of an index's entries: folders first, then each concept `type` alphabetically (deterministic, code-unit order). */
function sectionsOf(entries: readonly OkfIndexEntry[]): string[] {
  const out: string[] = [];
  if (entries.some((e) => e.section === BUNDLE_FOLDERS_SECTION)) out.push(BUNDLE_FOLDERS_SECTION);
  for (const type of [...new Set(entries.filter((e) => e.section !== BUNDLE_FOLDERS_SECTION).map((e) => e.section))].sort()) out.push(type);
  return out;
}

/** The section text of a directory index (no frontmatter, no intro): `renderIndex` over the given groups. */
function renderIndexEntries(entries: readonly OkfIndexEntry[]): string {
  return renderIndex({ sections: sectionsOf(entries), entries });
}

const basenameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const dirOf = (path: string): string => {
  const at = path.lastIndexOf('/');
  return at === -1 ? '' : path.slice(0, at);
};

/** The `index.md` that belongs to the directory holding a concept `path` (`memory/facts/x.md` -> `memory/facts/index.md`); null when `path` is not under `memory/`. */
export function bundleIndexPathFor(path: string): string | null {
  const dir = dirOf(path);
  if (dir !== 'memory' && !dir.startsWith('memory/')) return null;
  return `${dir}/index.md`;
}

/** A concept as the index and the log read it: its path and the frontmatter `parseConcept` accepted. */
export interface BundleConcept {
  path: string;
  frontmatter: OkfFrontmatter;
}

/** A display title: the frontmatter's, or one derived from the filename (OKF §4.1: consumers MAY derive a title from the filename). */
export function conceptTitle(path: string, frontmatter: Pick<OkfFrontmatter, 'title'>): string {
  const title = frontmatter.title?.trim();
  if (title) return title;
  const derived = basenameOf(path)
    .replace(/\.md$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return derived === '' ? basenameOf(path) : derived;
}

/**
 * Every `index.md` of a bundle, as a pure function of its concepts (PLAN criterion 18: byte-identical when regenerated from the same tree).
 * The root (`memory/index.md`, `okf_version` and the intro) is always present; a directory that holds concepts or subdirectories gets one, and
 * nothing else does — so a directory that loses its last concept loses its `index.md` (the caller deletes what the map does not name). Folders
 * are listed first, then one section per concept `type`; paths are sorted within a section.
 */
export function memoryIndexFiles(concepts: readonly BundleConcept[]): Map<string, string> {
  const direct = new Map<string, BundleConcept[]>();
  const dirs = new Set<string>(['memory']);
  for (const c of concepts) {
    const dir = dirOf(c.path);
    dirs.add(dir);
    for (let d = dir; d !== 'memory' && d !== ''; ) {
      d = dirOf(d);
      dirs.add(d);
    }
    const list = direct.get(dir);
    if (list) list.push(c);
    else direct.set(dir, [c]);
  }
  const out = new Map<string, string>();
  for (const dir of dirs) {
    const childDirs = [...dirs].filter((d) => d !== dir && dirOf(d) === dir).sort();
    const entries: OkfIndexEntry[] = [];
    for (const d of childDirs) entries.push({ section: BUNDLE_FOLDERS_SECTION, path: `${basenameOf(d)}/`, title: basenameOf(d), description: '' });
    const here = (direct.get(dir) ?? []).slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const type of [...new Set(here.map((c) => c.frontmatter.type))].sort()) {
      for (const c of here) {
        if (c.frontmatter.type !== type) continue;
        entries.push({
          section: type,
          path: dir === '' ? c.path : c.path.slice(dir.length + 1),
          title: conceptTitle(c.path, c.frontmatter),
          description: (c.frontmatter.description ?? '').trim(),
        });
      }
    }
    out.set(`${dir}/index.md`, dir === 'memory' ? renderBundleIndex(entries) : renderIndexEntries(entries));
  }
  return out;
}

/** The verb a log entry opens with, from a concept's `origin` (OKF §9: the leading bold word is a convention, not a requirement). */
const LOG_VERB: Readonly<Record<string, string>> = { drop: 'Filed', share: 'Received', journal: 'Journal', person: 'Note' };

/** The `YYYY-MM-DD` of an ISO datetime (an offset or a `Z`), or null when it is not one. */
const dayOf = (iso: string | undefined): string | null => (iso !== undefined && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null);

/**
 * `memory/log.md`, as a pure function of the bundle's concepts: one dated entry per concept, newest date first, path order within a date. The
 * date is `generated.at` (the platform stamps it on every write), so a concept with no `generated` — a file that reached git outside the writer
 * — is not in the log. The link is bundle-relative (`/`-absolute, OKF §6.1), because the log sits at the bundle root.
 */
export function memoryLogFile(concepts: readonly BundleConcept[]): string {
  const entries: BundleLogEntry[] = [];
  for (const c of [...concepts].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const date = dayOf(c.frontmatter.generated?.at);
    if (date === null) continue;
    const link = `/${c.path.replace(/^memory\//, '')}`;
    const verb = LOG_VERB[c.frontmatter.origin ?? ''] ?? 'Update';
    const description = (c.frontmatter.description ?? '').trim();
    entries.push({ date, text: `${verb}: [${conceptTitle(c.path, c.frontmatter)}](${link})${description === '' ? '' : ` — ${description}`}` });
  }
  return renderBundleLog(entries);
}
