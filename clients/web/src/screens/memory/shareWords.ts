import {
  SHARE_EXCLUSION_WORDS,
  ShareDefinition,
  parseCron,
  shareHeadline,
  type InboxItem,
  type ShareDestination,
  type ShareExcludedConcept,
  type ShareExclusionReason,
  type ShareIncoming,
  type ShareLinkState,
  type SharePreview,
  type ShareRunState,
  type ShareView,
} from '@manythreads/shared';

/*
 * The plain words and small rules of the Memory screen's Sharing tab (PLAN P8-26), kept apart from the components so a test can read them. Nothing here touches the
 * network. A **share** is the team's standing offer to pass some of its memory to other teams; a **digest** is one parcel of it; a **link** is one other team's side of
 * the offer (it asked, accepted, paused or ended). The server writes the sentences for what it did (a run's reason); these are the words for everything else.
 */

export type Tone = 'ok' | 'warn' | 'bad' | 'idle';
export type Look = { tone: Tone; glyph: string; label: string };

const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

// ---- links and destinations -------------------------------------------------------------------------------------------------------------------------------------

/** One word for where a destination team stands, with a shape as well as a colour. */
export function linkLook(state: ShareLinkState): Look {
  switch (state) {
    case 'requested':
      return { tone: 'warn', glyph: '…', label: 'Waiting for them' };
    case 'accepted':
      return { tone: 'ok', glyph: '✓', label: 'Accepted' };
    case 'paused':
      return { tone: 'idle', glyph: '‖', label: 'Paused by them' };
    case 'revoked':
      return { tone: 'bad', glyph: '×', label: 'Ended' };
  }
}

/** What a destination's state means for the sender, in a sentence. */
export function destinationSentence(d: Pick<ShareDestination, 'name' | 'slug' | 'link'>): string {
  const name = d.name || d.slug;
  switch (d.link) {
    case 'requested':
      return `${name} has not said yes yet. A lead of ${name} decides in Approvals, and nothing is sent until they do.`;
    case 'accepted':
      return `${name} receives every digest.`;
    case 'paused':
      return `${name} paused this. Nothing is sent there until they resume it.`;
    case 'revoked':
      return `${name} no longer receives this.`;
  }
}

/** "2 of 3 teams have accepted", or the plain reason there is nobody yet. */
export function acceptedLine(destinations: readonly Pick<ShareDestination, 'link'>[]): string {
  const total = destinations.length;
  const accepted = destinations.filter((d) => d.link === 'accepted').length;
  if (total === 0) return 'No team is named in this share.';
  if (accepted === 0) return total === 1 ? 'The team has not accepted yet.' : 'No team has accepted yet.';
  return `${String(accepted)} of ${plural(total, 'team', 'teams')} ${accepted === 1 ? 'has' : 'have'} accepted`;
}

// ---- how a share runs -------------------------------------------------------------------------------------------------------------------------------------------

export const modeWords = (mode: ShareView['mode']): string => (mode === 'full' ? 'A summary and a copy of each concept' : 'A short summary only');

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const DAY_KEYS: Readonly<Record<string, number>> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const clock = (hour: number, minute: number): string => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

/** When a share runs on its own, in words. A schedule that is not a plain daily or weekly one is shown as it is written. Times are UTC, as the server runs them. */
export function scheduleWords(cron: string | null): string {
  if (cron === null) return 'Only when someone presses Run now';
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-7]|[A-Za-z]{3})$/.exec(cron.trim());
  if (m) {
    const minute = Number(m[1]);
    const hour = Number(m[2]);
    const day = m[3] as string;
    if (minute <= 59 && hour <= 23) {
      if (day === '*') return `Every day at ${clock(hour, minute)} UTC`;
      const n = /^\d$/.test(day) ? Number(day) % 7 : DAY_KEYS[day.toLowerCase()];
      if (n !== undefined) return `Every ${DAYS[n] as string} at ${clock(hour, minute)} UTC`;
    }
  }
  return `On the schedule ${cron.trim()} (UTC)`;
}

/** How a digest is approved. `auto` asked for but not honoured says what the platform really does. */
export function approvalWords(view: Pick<ShareView, 'approval' | 'approvalEffective'>): string {
  if (view.approval === 'auto' && view.approvalEffective === 'review') return 'A lead approves each digest in Approvals (sending without a review needs a lead or admin to set it up)';
  return view.approvalEffective === 'auto' ? 'Goes out without a review' : 'A lead approves each digest in Approvals';
}

/** The sentence under an invalid share: the server's reason, or a plain one. */
export const invalidSentence = (view: Pick<ShareView, 'invalidReason'>): string => view.invalidReason?.trim() || 'The share’s file could not be read, so it does not run. Fix the file and it loads again.';

// ---- the last digest --------------------------------------------------------------------------------------------------------------------------------------------

const RUN_WORDS: Record<ShareRunState, Look> = {
  building: { tone: 'idle', glyph: '…', label: 'Being built' },
  empty: { tone: 'idle', glyph: '=', label: 'Nothing new to send' },
  blocked: { tone: 'bad', glyph: '!', label: 'Stopped by the checks' },
  awaiting_approval: { tone: 'warn', glyph: '?', label: 'Waiting for approval' },
  ready: { tone: 'ok', glyph: '✓', label: 'Approved, being sent' },
  denied: { tone: 'bad', glyph: '×', label: 'Not approved' },
  expired: { tone: 'bad', glyph: '×', label: 'Nobody approved it in time' },
  failed: { tone: 'bad', glyph: '!', label: 'Failed' },
  sent: { tone: 'ok', glyph: '✓', label: 'Sent' },
};
export const runLook = (state: ShareRunState): Look => RUN_WORDS[state];

/** A digest that is still moving: the page asks again until it stops. */
export const runIsMoving = (state: ShareRunState | undefined): boolean => state === 'building' || state === 'ready';

/** A run whose state the server explains in a sentence (`reason`): the page reads the run to show it. */
export const runHasReason = (state: ShareRunState): boolean => state === 'empty' || state === 'blocked' || state === 'failed' || state === 'denied' || state === 'expired';

/** Run now: whether it can be pressed, and if not the reason. The server checks all of this again. */
export function runNow(view: Pick<ShareView, 'status' | 'invalidReason' | 'lastRun'> & { destinations: readonly Pick<ShareDestination, 'link'>[] }, sharingOn: boolean, canManage: boolean): { ok: boolean; reason: string | null } {
  if (!canManage) return { ok: false, reason: 'Only a team lead or a workspace admin can run a share.' };
  if (view.status !== 'active') return { ok: false, reason: invalidSentence(view) };
  if (!sharingOn) return { ok: false, reason: 'Memory sharing is switched off for this workspace.' };
  if (view.lastRun?.state === 'building') return { ok: false, reason: 'A digest of this share is being built. Wait for it to finish.' };
  if (!view.destinations.some((d) => d.link === 'accepted')) return { ok: false, reason: 'No team has accepted this share yet, so there is nobody to send to.' };
  return { ok: true, reason: null };
}

// ---- the live preview -------------------------------------------------------------------------------------------------------------------------------------------

/** "Matches 12 concepts · 3 left out" (the server's sentence, or the same one built from the counts). */
export const previewHeadline = (p: Pick<SharePreview, 'headline' | 'counts'>): string => p.headline.trim() || shareHeadline(p.counts.matched, p.counts.leftOut);

/** What the next digest would carry: "2 new, 1 changed, 1 retired · 7 unchanged". */
export function previewDiffLine(p: Pick<SharePreview, 'diff'>): string {
  const { added, changed, retired, unchanged } = p.diff;
  const parts = [added.length > 0 ? `${String(added.length)} new` : null, changed.length > 0 ? `${String(changed.length)} changed` : null, retired.length > 0 ? `${String(retired.length)} retired` : null].filter(
    (x): x is string => x !== null,
  );
  const head = parts.length > 0 ? parts.join(', ') : 'Nothing new';
  return unchanged > 0 ? `${head} · ${String(unchanged)} unchanged` : head;
}

/** The left-out concepts grouped by reason, most first, each with the plain reason. */
export function leftOutGroups(excluded: readonly ShareExcludedConcept[]): Array<{ reason: ShareExclusionReason; words: string; items: ShareExcludedConcept[] }> {
  const by = new Map<ShareExclusionReason, ShareExcludedConcept[]>();
  for (const e of excluded) by.set(e.reason, [...(by.get(e.reason) ?? []), e]);
  return [...by.entries()]
    .map(([reason, items]) => ({ reason, words: SHARE_EXCLUSION_WORDS[reason], items }))
    .sort((a, b) => b.items.length - a.items.length || a.reason.localeCompare(b.reason));
}

/** "2 concepts: it is marked team only". */
export const leftOutLine = (g: { words: string; items: readonly unknown[] }): string => `${plural(g.items.length, 'concept', 'concepts')}: ${g.words}`;

// ---- the other side: what is sent to this team ------------------------------------------------------------------------------------------------------------------

/** The state of an incoming link as the receiving team sees it. */
export function incomingLook(link: Pick<ShareIncoming, 'state' | 'endedReason'>): Look {
  switch (link.state) {
    case 'requested':
      return { tone: 'warn', glyph: '?', label: 'Asking to share' };
    case 'accepted':
      return { tone: 'ok', glyph: '✓', label: 'Receiving' };
    case 'paused':
      return { tone: 'idle', glyph: '‖', label: 'Paused' };
    case 'revoked':
      return { tone: 'bad', glyph: '×', label: link.endedReason === 'removed' ? 'Stopped by the sender' : 'Ended' };
  }
}

export type IncomingChoice = 'accept' | 'decline' | 'pause' | 'resume' | 'end';
export type IncomingChoices = { choices: IncomingChoice[]; why: string | null };

/**
 * What a person may do with an incoming link. Only a lead of the receiving team or a workspace admin decides; a request is accepted or declined in its Approvals row
 * (so the link needs one), an open link is paused, resumed or ended. Anyone else is told who decides.
 */
export function incomingChoices(link: Pick<ShareIncoming, 'state' | 'approvalId'>, canManage: boolean): IncomingChoices {
  if (!canManage) return { choices: [], why: 'A lead of this team or a workspace admin decides what this team receives.' };
  switch (link.state) {
    case 'requested':
      return link.approvalId ? { choices: ['accept', 'decline'], why: null } : { choices: [], why: 'The request is not in Approvals yet. It appears there within a minute.' };
    case 'accepted':
      return { choices: ['pause', 'end'], why: null };
    case 'paused':
      return { choices: ['resume', 'end'], why: null };
    case 'revoked':
      return { choices: [], why: null };
  }
}

/** Why a request is not answered here, said up front (the same sentence the Approvals row uses for the person who asked). */
export const ASKED_BY_YOU_WHY = 'You asked for this, so someone else has to decide it.';
export const SHARING_OFF_WHY = 'Memory sharing is switched off for this workspace. A workspace admin has to switch it on before this can be answered.';

/**
 * The reason Accept and Decline cannot be pressed on a request right now, or null when they can. The person who filed the request (the Approvals row says so) never
 * decides it, and nothing is answered while workspace sharing is switched off. Both are shown before the press, so the server never has to refuse it.
 */
export function requestHold(opts: { sharingOn: boolean; askedByMe: boolean }): string | null {
  if (opts.askedByMe) return ASKED_BY_YOU_WHY;
  if (!opts.sharingOn) return SHARING_OFF_WHY;
  return null;
}

/** The pending Approvals rows that this person asked for themself, by id: the rows the list marks as blocked for the requester. */
export function askedByMeIds(rows: ReadonlyArray<{ id: string; canDecide: boolean; blockReason: string | null }>): Set<string> {
  return new Set(rows.filter((r) => !r.canDecide && r.blockReason === 'requester').map((r) => r.id));
}

export const CHOICE_WORDS: Record<IncomingChoice, { label: string; busy: string; done: (from: string) => string }> = {
  accept: { label: 'Accept', busy: 'Accepting…', done: (from) => `Accepted. ${from} can now send its digests here.` },
  decline: { label: 'Decline', busy: 'Declining…', done: (from) => `Declined. ${from} will not send anything here.` },
  pause: { label: 'Pause', busy: 'Pausing…', done: (from) => `Paused. Nothing arrives from ${from} until you resume.` },
  resume: { label: 'Resume', busy: 'Resuming…', done: (from) => `Resumed. ${from} can send digests here again.` },
  end: { label: 'Stop receiving', busy: 'Stopping…', done: (from) => `Stopped. ${from} no longer sends anything here.` },
};

/** The sentence under an incoming share. */
export function incomingSentence(link: Pick<ShareIncoming, 'state' | 'fromName' | 'shareName' | 'mode' | 'deliveries' | 'endedReason'>): string {
  const what = link.mode === 'full' ? 'a summary and a copy of each concept' : 'a short summary';
  switch (link.state) {
    case 'requested':
      return `${link.fromName} would like to send this team ${what} of what it knows. Nothing arrives unless you accept, and what arrives is kept apart from the team’s own memory.`;
    case 'accepted':
      return link.deliveries > 0 ? `${link.fromName} sends ${what}. ${plural(link.deliveries, 'digest has', 'digests have')} arrived.` : `${link.fromName} sends ${what}. No digest has arrived yet.`;
    case 'paused':
      return `You paused this. ${link.fromName} sends nothing until you resume it.`;
    case 'revoked':
      return link.endedReason === 'removed' ? `${link.fromName} stopped sending this.` : `This team ended it. ${link.fromName} sends nothing.`;
  }
}

/** The links a team has said yes to once (or has history from): the "Received from" list. A request that is still open is not in it. */
export const receivedLinks = (incoming: readonly ShareIncoming[]): ShareIncoming[] => incoming.filter((l) => l.state !== 'requested' && (l.state !== 'revoked' || l.deliveries > 0));
export const requestedLinks = (incoming: readonly ShareIncoming[]): ShareIncoming[] => incoming.filter((l) => l.state === 'requested');

/** A digest in the inbox is named `digests/<sending team slug>/<period>`; this reads the two parts back. */
export function digestName(name: string): { from: string; period: string } | null {
  const m = /^digests\/([a-z0-9][a-z0-9-]{0,62})\/([0-9]{4}-[0-9]{2}-[0-9]{2}(?:-[a-z0-9]{1,8})?)$/.exec(name);
  return m ? { from: m[1] as string, period: m[2] as string } : null;
}

/** The digests another team delivered, newest first, from the inbox items the team can see. */
export function digestsFrom(items: readonly Pick<InboxItem, 'origin' | 'name' | 'state' | 'createdAt' | 'filedPaths' | 'reason'>[], fromSlug: string): Array<{ period: string; state: InboxItem['state']; at: string; concepts: number; reason: string | null }> {
  const out: Array<{ period: string; state: InboxItem['state']; at: string; concepts: number; reason: string | null }> = [];
  for (const i of items) {
    if (i.origin !== 'share') continue;
    const parsed = digestName(i.name);
    if (!parsed || parsed.from !== fromSlug) continue;
    out.push({ period: parsed.period, state: i.state, at: i.createdAt, concepts: i.filedPaths.filter((p) => !p.startsWith('memory/references/')).length, reason: i.reason });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

const DIGEST_WORDS: Partial<Record<InboxItem['state'], string>> = {
  queued: 'Waiting to be filed',
  extracting: 'Being read',
  filing: 'Being filed',
  filed: 'Filed',
  held: 'Held for a lead',
  needs_review: 'Needs a look',
  failed: 'Could not be filed',
  duplicate: 'Already received',
};
export const digestStateWords = (state: InboxItem['state']): string => DIGEST_WORDS[state] ?? 'Discarded';

/** How many concepts in this team's memory came from the given team (the concept list marks them with the sender's id). */
export const conceptsFromTeam = (concepts: readonly { fromTeam: string | null }[], teamId: string): number => concepts.filter((c) => c.fromTeam === teamId).length;

// ---- the New share form -----------------------------------------------------------------------------------------------------------------------------------------

export type ScheduleChoice = 'manual' | 'daily' | 'weekly' | 'custom';
export const SCHEDULES: ReadonlyArray<{ id: ScheduleChoice; label: string; cron: string | null }> = [
  { id: 'manual', label: 'Only when someone presses Run now', cron: null },
  { id: 'daily', label: 'Every day at 08:00 UTC', cron: '0 8 * * *' },
  { id: 'weekly', label: 'Every Monday at 08:00 UTC', cron: '0 8 * * 1' },
  { id: 'custom', label: 'On another schedule', cron: null },
];

export type ShareDraft = {
  name: string;
  to: string[];
  /** Folders or files under memory/, one per line or comma-separated. */
  paths: string;
  types: string;
  tags: string;
  minTrust: 'unverified' | 'machine-confirmed' | 'human-reviewed';
  skipStale: boolean;
  mode: 'summary' | 'full';
  schedule: ScheduleChoice;
  cron: string;
  approval: 'review' | 'auto';
};

export const emptyDraft = (): ShareDraft => ({
  name: '',
  to: [],
  paths: '',
  types: '',
  tags: '',
  minTrust: 'unverified',
  skipStale: true,
  mode: 'summary',
  schedule: 'manual',
  cron: '',
  approval: 'review',
});

export const TRUST_CHOICES: ReadonlyArray<{ id: ShareDraft['minTrust']; label: string }> = [
  { id: 'unverified', label: 'Any concept (even one nobody has checked)' },
  { id: 'machine-confirmed', label: 'Only concepts a check has confirmed' },
  { id: 'human-reviewed', label: 'Only concepts a person has reviewed' },
];

/** "decisions/, playbooks" to ["decisions/", "playbooks"]: commas and new lines separate, blanks go, the same entry is kept once. */
export function splitList(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[,\n]/)) {
    const t = part.trim();
    if (t !== '' && !out.includes(t)) out.push(t);
  }
  return out;
}

/** A file name for a share from its name: lowercase letters, digits and dashes, at most 63. */
export const slugOfName = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');

export const shareFile = (slug: string): string => `routines/shares/${slug}.yaml`;

/** The cron the draft means, or null for a share that only runs by hand. */
export const draftCron = (d: Pick<ShareDraft, 'schedule' | 'cron'>): string | null => (d.schedule === 'custom' ? d.cron.trim() : (SCHEDULES.find((s) => s.id === d.schedule)?.cron ?? null));

/** What is wrong with the form, in plain words, or null when it can be sent. `taken` are the names of the files that already exist. */
export function draftProblem(d: ShareDraft, taken: ReadonlySet<string>): string | null {
  if (d.name.trim() === '') return 'Give the share a name.';
  const slug = slugOfName(d.name);
  if (slug === '') return 'Use letters or digits in the name.';
  if (taken.has(slug)) return 'A share with that name already exists. Pick another name, or change that share’s file.';
  if (d.to.length === 0) return 'Choose at least one team to send to.';
  if (d.schedule === 'custom') {
    if (d.cron.trim() === '') return 'Write the schedule, for example 0 8 * * 1 for Monday at 08:00.';
    try {
      parseCron(d.cron.trim());
    } catch {
      return 'The schedule is not understood. Use five parts: minute, hour, day of month, month, day of week.';
    }
  }
  const parsed = ShareDefinition.safeParse(draftToDefinition(d));
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'The share is not valid.');
}

/** The share definition the form means (the shape the server checks again). */
export function draftToDefinition(d: ShareDraft): ShareDefinition {
  const paths = splitList(d.paths).map((p) => p.replace(/^\/?memory\//, ''));
  const types = splitList(d.types);
  const tags = splitList(d.tags);
  const cron = draftCron(d);
  return {
    name: d.name.trim(),
    to: d.to,
    select: { ...(paths.length > 0 ? { paths } : {}), ...(types.length > 0 ? { types } : {}), ...(tags.length > 0 ? { tags } : {}), minTrust: d.minTrust, skipStale: d.skipStale },
    mode: d.mode,
    when: cron === null ? 'manual' : { cron },
    approval: d.approval,
    approvers: ['role:lead'],
  };
}

const q = (s: string): string => JSON.stringify(s);
const flow = (items: readonly string[]): string => `[${items.map(q).join(', ')}]`;

/** The text of `routines/shares/<slug>.yaml` for a definition. Every free-text value is a double-quoted string, so nothing a person types can change the file's shape. */
export function definitionYaml(def: ShareDefinition): string {
  const lines = [`name: ${q(def.name)}`, `to: [${def.to.join(', ')}]`, 'select:'];
  if (def.select.paths) lines.push(`  paths: ${flow(def.select.paths)}`);
  if (def.select.types) lines.push(`  types: ${flow(def.select.types)}`);
  if (def.select.tags) lines.push(`  tags: ${flow(def.select.tags)}`);
  lines.push(`  minTrust: ${def.select.minTrust}`, `  skipStale: ${String(def.select.skipStale)}`, `mode: ${def.mode}`);
  lines.push(typeof def.when === 'object' && 'cron' in def.when ? `when: { cron: ${q(def.when.cron)} }` : 'when: manual');
  lines.push(`approval: ${def.approval}`, 'approvers: [role:lead]');
  return `${lines.join('\n')}\n`;
}

/** The title of the proposal the form files. */
export const proposalTitle = (name: string): string => `Share “${name.trim()}” with other teams`;
