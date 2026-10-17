import { OKF_VERSION, serializeConcept } from './concept.ts';

// The two files the platform keeps at the root of a team's memory bundle (SPEC §12.1, §5.1): `memory/index.md` (frontmatter `okf_version: "0.2"`
// and nothing else) and `memory/log.md` (date-grouped, newest first). P5-14 writes each ONCE, when a team's memory is first used; P5-25 makes the
// repo writer regenerate them (and every directory's `index.md`) deterministically in the same commit as a change, and P5-24's `OkfIndex` /
// `OkfLog` take these two renderers over. Pure: no clock, no database, no model.

/** `memory/index.md`: the bundle root. */
export function renderBundleIndex(): string {
  return serializeConcept(
    { okf_version: OKF_VERSION },
    [
      '# Team memory',
      '',
      "This folder is the team's memory: an OKF bundle (one Markdown file per concept, YAML frontmatter with a `type`).",
      'People edit it like any file; the platform indexes each concept for recall and keeps this file and `log.md`.',
    ].join('\n'),
  );
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
