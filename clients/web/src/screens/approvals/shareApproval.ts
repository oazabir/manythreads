import { MEMORY_DIGEST_SEND_TOOL, MEMORY_SHARE_ACCEPT_TOOL, SHARE_EXCLUSION_WORDS, ShareExclusionReason, type Approval } from '@manythreads/shared';
import { scheduleWords } from '../memory/shareWords';

/*
 * The words of the two memory-sharing requests that sit in Approvals (docs/plugins/memory-share.md): a team being asked to receive another team's share
 * (`memory.share.accept`), and a digest waiting to be sent (`memory.digest.send`). Neither is a bot's call: a person asked, so the card names the team and the
 * share, not "a bot" or the tool. The preview the server stores holds counts, titles and reasons, never the text of a concept. Nothing here touches the network.
 */

export const isShareApproval = (a: Pick<Approval, 'tool'>): boolean => a.tool === MEMORY_SHARE_ACCEPT_TOOL || a.tool === MEMORY_DIGEST_SEND_TOOL;

/** The small heading of the card: what kind of request it is. */
export function shareKind(tool: string): string {
  return tool === MEMORY_SHARE_ACCEPT_TOOL ? 'Memory sharing · request to receive' : 'Memory sharing · digest to send';
}

/** The line in the Approvals list: the kind (and, as always, the bot when a bot asked). */
export const approvalRowLabel = (a: Pick<Approval, 'tool' | 'botName'>): string => (isShareApproval(a) ? shareKind(a.tool) : a.botName ? `${a.botName} · ${a.tool}` : a.tool);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []);
const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

const MODE_WORDS: Record<string, string> = { summary: 'a short summary only', full: 'a summary and a copy of each concept' };
const TRUST_WORDS: Record<string, string> = { 'machine-confirmed': 'concepts a check has confirmed', 'human-reviewed': 'concepts a person has reviewed' };

/** What a share picks, in words: "folders decisions/ · kinds Decision · only concepts a check has confirmed · skips what is out of date". */
export function selectWords(select: unknown): string {
  if (!isRecord(select)) return 'All of the team’s memory that may be shared';
  const parts: string[] = [];
  const paths = list(select['paths']);
  const types = list(select['types']);
  const tags = list(select['tags']);
  if (paths.length > 0) parts.push(`folders ${paths.join(', ')}`);
  if (types.length > 0) parts.push(`kinds ${types.join(', ')}`);
  if (tags.length > 0) parts.push(`tags ${tags.join(', ')}`);
  const trust = TRUST_WORDS[text(select['minTrust'])];
  if (trust) parts.push(`only ${trust}`);
  const base = parts.length > 0 ? parts.join(' · ') : 'All of the team’s memory that may be shared';
  return select['skipStale'] === false ? base : `${base} · skips what is out of date`;
}

export type AcceptView = { rows: Array<{ label: string; value: string }>; note: string };

/** The preview of a request to receive a share, as labelled rows. */
export function acceptView(preview: Record<string, unknown>): AcceptView {
  const when = preview['when'];
  const cron = isRecord(when) && typeof when['cron'] === 'string' ? when['cron'] : null;
  const approval = text(preview['approval']) === 'auto' ? 'Sent without a review once set up by a lead' : 'A lead of the sending team approves each digest';
  return {
    rows: [
      { label: 'From', value: text(preview['from']) || 'Another team' },
      { label: 'Share', value: text(preview['share']) },
      { label: 'It sends', value: MODE_WORDS[text(preview['mode'])] ?? 'a short summary only' },
      { label: 'It picks', value: selectWords(preview['select']) },
      { label: 'How often', value: scheduleWords(cron) },
      { label: 'Before it goes', value: approval },
    ].filter((r) => r.value !== ''),
    note: 'If you accept, digests from this team are filed apart from your own memory and start out unchecked. You can pause or stop it later from the Memory screen’s Sharing tab. You cannot decide a request you wrote yourself.',
  };
}

export type DigestView = {
  to: Array<{ team: string; link: string }>;
  headline: string;
  counts: string;
  included: string[];
  leftOut: Array<{ words: string; titles: string[] }>;
  diff: string;
  more: string | null;
  mode: string;
  period: string;
  from: string;
};

/** The preview of a digest waiting to go: where it goes, how much it holds, what it leaves out and why, and what changed since last time. */
export function digestView(preview: Record<string, unknown>): DigestView {
  const to = Array.isArray(preview['to']) ? preview['to'].filter(isRecord).map((t) => ({ team: text(t['team']), link: text(t['link']) })).filter((t) => t.team !== '') : [];
  const counts = isRecord(preview['counts']) ? preview['counts'] : {};
  const included = Array.isArray(preview['included']) ? preview['included'].filter(isRecord).map((c) => text(c['title']) || text(c['path'])).filter((t) => t !== '') : [];
  const byReason = new Map<string, string[]>();
  for (const e of Array.isArray(preview['excluded']) ? preview['excluded'].filter(isRecord) : []) {
    const reason = ShareExclusionReason.safeParse(e['reason']);
    const words = reason.success ? SHARE_EXCLUSION_WORDS[reason.data] : 'it may not leave the team';
    byReason.set(words, [...(byReason.get(words) ?? []), text(e['title']) || text(e['path'])]);
  }
  const diff = isRecord(preview['diff']) ? preview['diff'] : {};
  const n = (k: string): number => (Array.isArray(diff[k]) ? (diff[k] as unknown[]).length : 0);
  const diffParts = [n('added') > 0 ? `${String(n('added'))} new` : null, n('changed') > 0 ? `${String(n('changed'))} changed` : null, n('retired') > 0 ? `${String(n('retired'))} retired` : null].filter((x): x is string => x !== null);
  const more = isRecord(preview['more']) ? count(preview['more']['included']) + count(preview['more']['excluded']) : 0;
  const matched = count(counts['matched']);
  const out = count(counts['leftOut']);
  return {
    to,
    headline: `Matches ${plural(matched, 'concept', 'concepts')} · ${String(out)} left out`,
    counts: `${String(count(counts['included']))} new or updated · ${String(count(counts['unchanged']))} unchanged${count(counts['redacted']) > 0 ? ` · ${plural(count(counts['redacted']), 'concept had', 'concepts had')} private details covered up` : ''}`,
    included,
    leftOut: [...byReason.entries()].map(([words, titles]) => ({ words, titles })).sort((a, b) => b.titles.length - a.titles.length),
    diff: `${diffParts.length > 0 ? diffParts.join(', ') : 'Nothing new'}${count(diff['unchanged']) > 0 ? ` · ${String(count(diff['unchanged']))} unchanged` : ''}`,
    more: more > 0 ? `and ${String(more)} more not listed here` : null,
    mode: MODE_WORDS[text(preview['mode'])] ?? '',
    period: text(preview['period']),
    from: text(preview['from']),
  };
}

/** What became of an approved or denied sharing request, in one sentence. Empty when the call is the ordinary kind. */
export function shareOutcomeLine(a: Pick<Approval, 'tool' | 'status' | 'outcome' | 'outcomeDetail'>): string {
  const accept = a.tool === MEMORY_SHARE_ACCEPT_TOOL;
  if (a.status === 'denied') return accept ? 'Declined. Nothing will be sent to this team from this share.' : 'Not approved. The digest was not sent.';
  if (a.status === 'expired') return accept ? 'Nobody answered in time, so the request lapsed. The sending team can ask again.' : 'Nobody approved it in time, so it lapsed. Run the share again to make a new one.';
  if (a.outcome === 'failed') return `Approved, but it did not go through: ${a.outcomeDetail || 'it failed'}`;
  return accept ? 'Accepted. The sending team can now send its digests here.' : 'Approved. The digest goes to each team that accepted it.';
}
