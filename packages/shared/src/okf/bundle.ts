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
