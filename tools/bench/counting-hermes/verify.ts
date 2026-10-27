/**
 * The pure half of the Hermes counting benchmark (PLAN P6-10): what a finished run has to look like. Kept free of the network so a unit
 * test can feed it a good log and every kind of bad one.
 *
 * The counter is the description of the card: each bot appends one line `<n> <slug>` while it owns the card, so the final text is the log.
 */
export interface CardEvent {
  type: string;
  actorId: string | null;
  createdAt: string;
}

export interface CounterLine {
  n: number;
  slug: string;
}

export interface Verdict {
  ok: boolean;
  failures: string[];
  /** The lines of the description that parsed, in order. */
  lines: CounterLine[];
}

/** One `<n> <slug>` per line; a line that does not match is reported, never skipped. Linear: a line is split once, no regex backtracking. */
export function parseLog(description: string): { lines: CounterLine[]; bad: string[] } {
  const lines: CounterLine[] = [];
  const bad: string[] = [];
  for (const raw of description.split('\n')) {
    const text = raw.trim();
    if (text === '') continue;
    const space = text.indexOf(' ');
    const head = space < 0 ? text : text.slice(0, space);
    const slug = space < 0 ? '' : text.slice(space + 1).trim();
    const n = /^[0-9]{1,6}$/.test(head) ? Number(head) : NaN;
    if (Number.isNaN(n) || slug === '' || slug.includes(' ')) bad.push(text.slice(0, 80));
    else lines.push({ n, slug });
  }
  return { lines, bad };
}

/**
 * Judges a run: the log reads 1 to `bots` in order with no gap or duplicate, every bot counted once, and the card's own history is
 * `claimed`, `released`, `claimed`, `released`, ... so the card never had two owners, each release by the actor that claimed.
 * `slugToActor` maps a bot slug to its actor id (what `task_events.actorId` carries).
 */
export function judge(input: { bots: number; description: string; events: CardEvent[]; slugToActor: ReadonlyMap<string, string> }): Verdict {
  const { bots, description, events, slugToActor } = input;
  const failures: string[] = [];
  const { lines, bad } = parseLog(description);
  for (const b of bad) failures.push(`a line of the log is not "<n> <slug>": "${b}"`);

  if (lines.length !== bots) failures.push(`the log has ${String(lines.length)} lines, expected ${String(bots)}`);
  lines.forEach((l, i) => {
    if (l.n !== i + 1) failures.push(`line ${String(i + 1)} reads ${String(l.n)} (${l.slug}): a gap, a duplicate or an overwrite`);
  });
  const seen = new Set<string>();
  for (const l of lines) {
    if (seen.has(l.slug)) failures.push(`${l.slug} counted more than once`);
    seen.add(l.slug);
    if (!slugToActor.has(l.slug)) failures.push(`${l.slug} is not one of the bench bots`);
  }
  for (const slug of slugToActor.keys()) if (!seen.has(slug)) failures.push(`${slug} never counted`);

  // The turn log: strictly claimed/released pairs by one actor each.
  const turns = events.filter((e) => e.type === 'claimed' || e.type === 'released');
  let holder: string | null = null;
  const claimers: string[] = [];
  for (const e of turns) {
    if (e.type === 'claimed') {
      if (holder !== null) failures.push(`two owners at once: ${e.actorId ?? 'nobody'} claimed while ${holder} still held the card`);
      holder = e.actorId ?? 'nobody';
      claimers.push(holder);
    } else {
      if (holder === null) failures.push(`${e.actorId ?? 'nobody'} released a card nobody held`);
      else if (e.actorId !== holder) failures.push(`${e.actorId ?? 'nobody'} released a card that ${holder} held`);
      holder = null;
    }
  }
  if (holder !== null) failures.push(`the card is still held by ${holder} at the end`);
  const claimed = turns.filter((e) => e.type === 'claimed').length;
  const released = turns.filter((e) => e.type === 'released').length;
  if (claimed !== bots) failures.push(`${String(claimed)} claims, expected ${String(bots)}`);
  if (released !== bots) failures.push(`${String(released)} releases, expected ${String(bots)}`);
  if (new Set(claimers).size !== claimers.length) failures.push('an actor claimed the card more than once');

  return { ok: failures.length === 0, failures, lines };
}
