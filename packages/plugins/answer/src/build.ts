import {
  ANSWER_LIMITS,
  AnswerPayload,
  clip,
  type AnswerCitationInput,
  type AnswerInput,
  type AnswerOutsideReason,
} from '@manythreads/shared';
import type { AnswerView, Resolved } from './view.ts';

// The pure half of `answer.post`: what the bot sent plus what the asker's view said of it becomes the payload that is stored on the message.
// Nothing here reads a database or a clock, so every rule of the answer is a unit test:
//
//   * a citation of something the run never reached (its source log does not have it) is not looked up at all and is only counted, with its
//     own reason: the bot's capabilities bound what it can cite, and a citation is no way to ask whether an id exists;
//   * a citation the asker cannot read is NOT in the payload, and nothing of it is: no label, no snippet, no id. It is a kind and a count;
//   * a citation the asker can read but the reply's readers cannot (a private source cited into a team channel) is dropped the same way,
//     with a different reason;
//   * every label, scope and date comes from the platform's reading of the source; the bot contributes only its quote (`snippet`);
//   * `answeredFor` is the run's asker, never a field of the input (the input schema is strict and has none).

const DEFAULT_LABEL: Record<AnswerCitationInput['kind'], string> = {
  message: 'A message',
  thread: 'A thread',
  page: 'A page',
  file: 'A file',
  run: 'A run',
  memory: 'A memory item',
};

/** The id a citation names, as the SQL view reads it and as the dropped-item set keys it. */
export function citationRef(c: AnswerCitationInput): { kind: string; ref: string; team: string | null } {
  switch (c.kind) {
    case 'message':
      return { kind: 'message', ref: c.messageId, team: null };
    case 'thread':
      return { kind: 'thread', ref: c.threadRootId, team: null };
    case 'page':
      return { kind: 'page', ref: c.path, team: c.teamId ?? null };
    case 'file':
      return { kind: 'file', ref: c.fileId, team: null };
    case 'run':
      return { kind: 'run', ref: c.runId, team: null };
    case 'memory':
      return { kind: 'memory', ref: c.conceptPath, team: null };
  }
}

const iso = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

export interface BuiltAnswer {
  payload: AnswerPayload;
  /** Citations the bot sent that are not in the payload. */
  droppedCitations: number;
  /** Citations that are. */
  keptCitations: number;
}

/**
 * Builds the payload. `view.citations[i]` is the asker's reading of `input.citations[i]` — the caller guarantees the same length; a shorter view
 * (it cannot happen with the SQL function) reads the missing ones as not found, so the safe answer is always "drop it".
 */
export function buildAnswer(input: AnswerInput, view: AnswerView): BuiltAnswer {
  // plain objects: `AnswerPayload.parse` below is what brands the ids and proves the shape, so there is one place that says what a payload is
  const citations: Array<Record<string, unknown>> = [];
  const lineage: Array<Record<string, unknown>> = [];
  // distinct items that are out of scope, by what they are: a source both read and cited is one item, not two
  const outside = new Map<string, { kind: string; reason: AnswerOutsideReason }>();
  const leave = (kind: string, ref: string, reason: AnswerOutsideReason): void => {
    const key = `${kind}:${ref}`;
    if (!outside.has(key)) outside.set(key, { kind, reason });
  };

  let dropped = 0;
  input.citations.forEach((c, index) => {
    const n = index + 1;
    const { kind, ref } = citationRef(c);
    const seen: Resolved = view.citations[index] ?? { found: false };
    // first, whatever else is true of it: a source the run did not reach is not discussed (nothing was looked up, so there is nothing to know)
    if (seen.reached === false) {
      dropped += 1;
      leave(kind, ref, 'not_reached');
      return;
    }
    if (!seen.found || seen.scope === undefined) {
      dropped += 1;
      leave(kind, ref, 'not_visible');
      return;
    }
    if (seen.audience !== true) {
      dropped += 1;
      leave(kind, ref, 'not_shared');
      return;
    }
    const label = clip((seen.label ?? '').trim() === '' ? DEFAULT_LABEL[c.kind] : (seen.label as string).trim(), ANSWER_LIMITS.label);
    const base = { n, label, scope: seen.scope };
    let citation: Record<string, unknown> | null = null;
    switch (c.kind) {
      case 'message':
        if (seen.channelId && seen.channelKind) {
          citation = { kind: 'message', ...base, messageId: c.messageId, channelId: seen.channelId, teamId: seen.teamId ?? null, channelKind: seen.channelKind, channelName: seen.channelName ?? null, threadRootId: seen.threadRootId ?? null };
        }
        break;
      case 'thread':
        if (seen.channelId && seen.channelKind) {
          citation = { kind: 'thread', ...base, threadRootId: c.threadRootId, channelId: seen.channelId, teamId: seen.teamId ?? null, channelKind: seen.channelKind, channelName: seen.channelName ?? null };
        }
        break;
      case 'page':
        if (seen.teamId) citation = { kind: 'page', ...base, teamId: seen.teamId, path: c.path };
        break;
      case 'file':
        citation = { kind: 'file', ...base, fileId: c.fileId };
        break;
      case 'run':
        if (seen.botId) citation = { kind: 'run', ...base, runId: c.runId, botId: seen.botId, botSlug: seen.botSlug ?? null };
        break;
      case 'memory':
        if (seen.conceptType && seen.trustTier) citation = { kind: 'memory', ...base, conceptPath: c.conceptPath, type: seen.conceptType, trustTier: seen.trustTier, stale: seen.stale ?? false, deprecated: seen.deprecated ?? false, fromTeam: seen.fromTeam ?? null };
        break;
    }
    if (citation === null) {
      // the view did not say what it should have: treated as unreadable rather than guessed at
      dropped += 1;
      leave(kind, ref, 'not_visible');
      return;
    }
    citations.push(citation);
    lineage.push({
      n,
      kind: c.kind,
      label,
      at: iso(seen.at),
      snippet: c.snippet === undefined || c.snippet.trim() === '' ? null : clip(c.snippet.trim(), ANSWER_LIMITS.snippet),
    });
  });

  // what the run read: kept when the asker can still read it and the reply's readers may; anything else is only counted
  const sourcesReached: Array<Record<string, unknown>> = [];
  for (const s of view.sources) {
    if (!s.found) {
      leave(s.kind, s.ref, 'not_visible');
      continue;
    }
    if (s.audience !== true) {
      leave(s.kind, s.ref, 'not_shared');
      continue;
    }
    if (sourcesReached.length >= ANSWER_LIMITS.sources) continue;
    const label = s.label && s.label.trim() !== '' ? clip(s.label.trim(), ANSWER_LIMITS.label) : s.kind === 'memory' ? 'Team memory' : null;
    sourcesReached.push({ kind: sourceKind(s.kind), ref: clip(s.ref, 200), label, marker: s.logScope === 'person' ? 'scoped' : 'full' });
  }

  // what the bot said it could not reach: a kind and a count, merged with what the platform removed
  const grouped = new Map<string, { kind: string; reason: AnswerOutsideReason; count: number }>();
  const add = (kind: string, reason: AnswerOutsideReason, count: number): void => {
    const key = `${kind}|${reason}`;
    const hit = grouped.get(key);
    if (hit) hit.count += count;
    else grouped.set(key, { kind, reason, count });
  };
  for (const item of outside.values()) add(sourceKind(item.kind), item.reason, 1);
  for (const declared of input.outsideScope) add(declared.kind, 'not_granted', declared.count);
  const items = [...grouped.values()].slice(0, ANSWER_LIMITS.outside * 3);
  const outsideCount = [...grouped.values()].reduce((sum, i) => sum + i.count, 0);

  // chips: a follow-up is a question to ask; a hand-off names a bot of the team the platform found (never one it could not)
  const chips: Array<Record<string, unknown>> = [];
  const prompts = new Set<string>();
  const handedTo = new Set<string>();
  for (const chip of input.chips) {
    if (chip.kind === 'followup') {
      const prompt = chip.prompt.trim();
      if (prompt === '' || prompts.has(prompt)) continue;
      prompts.add(prompt);
      chips.push({ kind: 'followup', label: clip((chip.label ?? prompt).trim() || prompt, 120), prompt });
    } else {
      const bot = view.bots.find((b) => b.slug === chip.botSlug);
      if (!bot || handedTo.has(bot.id)) continue;
      handedTo.add(bot.id);
      chips.push({ kind: 'handoff', botId: bot.id, botSlug: bot.slug, botName: clip(bot.name, 120) });
    }
  }

  const run = view.run;
  const payload = AnswerPayload.parse({
    version: 1,
    body: input.body,
    citations,
    lineage,
    sourcesReached,
    outsideScope: { count: outsideCount, items },
    answeredFor: {
      personId: run.askerPersonId,
      name: run.askerName === null ? null : clip(run.askerName, 200),
      scope: run.hasAsker ? 'scoped' : 'team',
      alias: run.alias === null ? null : clip(run.alias, ANSWER_LIMITS.alias),
      botId: run.botId,
      runId: run.runId,
    },
    chips: chips.slice(0, ANSWER_LIMITS.chips),
  });
  return { payload, droppedCitations: dropped, keptCitations: citations.length };
}

/** A source kind from the run's log (`message`, `file`, `memory`, ...) in the shape the payload allows; anything odd is just `source`. */
function sourceKind(kind: string): string {
  return /^[a-z][a-z0-9_]{0,31}$/.test(kind) ? kind : 'source';
}
