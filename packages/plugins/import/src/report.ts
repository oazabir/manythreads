import {
  IMPORT_SKIP_REASONS,
  ImportReport,
  type ImportChannelLine,
  type ImportSkipReason,
  importSkipPhrase,
} from '@manythreads/shared';
import { CHANNEL_LINES_MAX } from './limits.ts';

/** Everything a run counts. One tally serves the dry run (what would happen) and the real run (what happened). */
export class Tally {
  people = { total: 0, matched: 0, placeholders: 0, withoutEmail: 0, matchedNotOnTeam: 0 };
  channels = { total: 0, public: 0, private: 0, direct: 0, imported: 0, skipped: 0 };
  messages = { total: 0, imported: 0, alreadyImported: 0, threads: 0, replies: 0, reactions: 0, mentions: 0 };
  files = { total: 0, inArchive: 0, notInArchive: 0 };
  readonly skipped = new Map<ImportSkipReason, number>();
  readonly channelLines: ImportChannelLine[] = [];

  skip(reason: ImportSkipReason, n = 1): void {
    this.skipped.set(reason, (this.skipped.get(reason) ?? 0) + n);
  }

  skippedTotal(): number {
    let n = 0;
    for (const v of this.skipped.values()) n += v;
    return n;
  }
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
/** The verb that agrees with a count: "1 person has", "2 people have". */
const verb = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** The sentences an admin reads first. No names of people or channels; only numbers, so the audit log and a screenshot reveal nothing. */
function sentences(t: Tally, mode: 'dry' | 'final'): string[] {
  const dry = mode === 'dry';
  const out: string[] = [];
  const n = (x: number): string => x.toLocaleString('en-US');
  out.push(
    `The archive holds ${plural(t.people.total, 'person', 'people')}, ${plural(t.channels.total, 'channel')} (${t.channels.public} public, ${t.channels.private} private, ${t.channels.direct} direct) and ${plural(t.messages.total, 'message')}.`,
  );
  out.push(
    `${plural(t.people.matched, 'person', 'people')} ${dry ? verb(t.people.matched, 'has', 'have') : 'had'} an account here with the same email address, so their messages ${dry ? 'will be' : 'are'} theirs.` +
      (t.people.placeholders > 0
        ? ` ${plural(t.people.placeholders, 'person', 'people')} ${dry ? verb(t.people.placeholders, 'has', 'have') : 'had'} none: their messages ${dry ? 'will show' : 'show'} their name with "(imported)" until someone signs in with the same email address, who then takes them over.`
        : ''),
  );
  if (t.people.withoutEmail > 0) {
    out.push(`${plural(t.people.withoutEmail, 'person', 'people')} ${dry ? verb(t.people.withoutEmail, 'has', 'have') : 'had'} no email address in the archive, so nobody can take over their messages.`);
  }
  if (t.people.matchedNotOnTeam > 0) {
    out.push(
      `${plural(t.people.matchedNotOnTeam, 'matched person', 'matched people')} ${dry ? verb(t.people.matchedNotOnTeam, 'is', 'are') : verb(t.people.matchedNotOnTeam, 'was', 'were')} not on the chosen team, so ${dry ? 'they will not be' : 'they were not'} added to private channels.`,
    );
  }
  out.push(
    dry
      ? `${plural(t.channels.imported, 'channel')} will be made or filled; ${plural(t.channels.skipped, 'channel')} will be left out.`
      : `${plural(t.channels.imported, 'channel')} ${verb(t.channels.imported, 'was', 'were')} made or filled; ${plural(t.channels.skipped, 'channel')} ${verb(t.channels.skipped, 'was', 'were')} left out.`,
  );
  const startsThread = `${n(t.messages.threads)} ${verb(t.messages.threads, 'starts', 'start')} a thread`;
  out.push(
    dry
      ? `${plural(t.messages.imported, 'message')} will be written (${startsThread}, ${plural(t.messages.replies, 'reply', 'replies')}).`
      : `${plural(t.messages.imported, 'message')} ${verb(t.messages.imported, 'was', 'were')} written (${startsThread}, ${plural(t.messages.replies, 'reply', 'replies')}).`,
  );
  if (t.messages.alreadyImported > 0) {
    out.push(
      `${plural(t.messages.alreadyImported, 'message')} came in on an earlier run of this archive and ${dry ? 'will not be' : verb(t.messages.alreadyImported, 'was not', 'were not')} written twice.`,
    );
  }
  out.push(
    `${plural(t.messages.reactions, 'reaction')} ${dry ? verb(t.messages.reactions, 'comes', 'come') : 'came'} along. ${plural(t.messages.mentions, 'mention')} ${dry ? 'will read' : 'read'} as plain text and notify nobody. Every message keeps the time it was written.`,
  );
  if (t.files.total > 0) {
    out.push(
      `${plural(t.files.total, 'file')} ${dry ? verb(t.files.total, 'is', 'are') : verb(t.files.total, 'was', 'were')} named in messages (${t.files.inArchive} with ${t.files.inArchive === 1 ? 'its' : 'their'} bytes in the archive). Files are not copied yet: each message keeps a line with the file's name.`,
    );
  }
  for (const reason of IMPORT_SKIP_REASONS) {
    const count = t.skipped.get(reason);
    if (count) out.push(`${importSkipPhrase(reason, count)} ${dry ? 'will be left out or changed' : verb(count, 'was', 'were') + ' left out or changed'}.`);
  }
  if (dry) out.push('Nothing has been written yet. Start the import to write it.');
  return out.slice(0, 40).map((s) => s.slice(0, 300));
}

/** The report as the API sends it. */
export function buildReport(t: Tally, mode: 'dry' | 'final'): ImportReport {
  const lines = [...t.channelLines].sort((a, b) => b.messages - a.messages).slice(0, CHANNEL_LINES_MAX);
  return ImportReport.parse({
    people: t.people,
    channels: t.channels,
    messages: t.messages,
    files: t.files,
    skipped: IMPORT_SKIP_REASONS.filter((r) => (t.skipped.get(r) ?? 0) > 0).map((reason) => ({ reason, count: t.skipped.get(reason)! })),
    channelLines: lines,
    lines: sentences(t, mode),
  });
}
