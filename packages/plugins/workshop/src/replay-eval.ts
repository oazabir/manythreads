import {
  LLM_GUARD_PRESETS,
  REPLAY_MAX_CHANGES,
  compileGate,
  matchGate,
  type CompiledGate,
  type LlmGuardPreset,
  type ReplayChange,
  type ReplayCounts,
  type ReplayResult,
  type ReplayState,
  type ReplayVerdict,
  type RunDecisionKind,
  type RunDecisionOutcome,
} from '@manythreads/shared';
import { plainAlias, plainTool } from './labels.ts';

// Replay of recorded decisions (PLAN P7-07), the pure part: it takes what a run recorded and what the rules are today, and says whether each decision would come out differently.
// NOTHING here calls a model, reads a database or writes anything. The caller (`replay.ts`) gathers the facts in the viewer's own transaction; this file only compares.
//
// What can and cannot be asked again, stated once:
//   gate   the bot's topic list (stage one) can: it is a list of phrases and patterns, run against the message as it is now. The local model's topic check (stage two) cannot be
//          repeated for free: a decision it made stays as recorded and is reported as "not replayed".
//   tool   the grants of the day can: the platform's own door is asked again (`ctx.capabilities.preview`) and answers without a trace.
//   guard  only at the level of the workspace's guard preset (air-gapped, customer-facing, ...). What the data check found in a call is not kept (it would be the secret itself), so
//          a detection cannot be re-run; what the preset does with a detection can. The per-detector choices an admin made since are not kept either.

/** The four places a decision can land, mildest first. */
const RANK: Record<ReplayState, number> = { allowed: 0, redacted: 1, waits_for_person: 2, refused: 3 };

/** One decision as the database kept it, with what the replay needs to know about its run. */
export interface RecordedDecision {
  runId: string;
  /** When the decision was made. */
  at: string;
  kind: RunDecisionKind;
  subject: string;
  outcome: RunDecisionOutcome;
  target: string | null;
  messageId: string | null;
  detail: Record<string, unknown>;
  /** What started the run (`conversation`, `mention`, ...): a grant can depend on it. */
  trigger: string;
}

/** The message a gate decision read, as the VIEWER can read it now: its text, or why it is not there. Never copied into a result. */
export type MessageNow = { kind: 'text'; text: string } | { kind: 'unreadable' } | { kind: 'edited' };

/** The bot's gate today. `unreadable`: BOT.md could not be read or loaded. `none`: no topic list. `invalid`: a list the platform refuses (the real gate then holds everything). */
export type GateNow = { kind: 'unreadable' } | { kind: 'none' } | { kind: 'invalid' } | { kind: 'list'; compiled: CompiledGate; topics: number };

/** What the broker answers today for a recorded tool call, or that it could not be asked. */
export type ToolNow = { allowed: boolean; needsApproval: boolean } | { unavailable: true } | { tooMany: true };

export function prepareGate(entries: readonly string[] | null | undefined, readable: boolean): GateNow {
  if (!readable) return { kind: 'unreadable' };
  if (!entries || entries.length === 0) return { kind: 'none' };
  const compiled = compileGate(entries);
  if (!compiled.ok) return { kind: 'invalid' };
  return { kind: 'list', compiled: compiled.gate, topics: compiled.gate.entries.filter((e) => e.kind === 'phrase').length };
}

/** A recorded outcome on the one scale. */
export function recordedState(kind: RunDecisionKind, outcome: RunDecisionOutcome): ReplayState | null {
  switch (outcome) {
    case 'passed':
    case 'allow':
    case 'allowed':
      return 'allowed';
    case 'redact':
      return kind === 'guard' ? 'redacted' : null;
    case 'held':
    case 'require_approval':
    case 'needs_approval':
      return 'waits_for_person';
    case 'refused':
    case 'block':
    case 'denied':
      return 'refused';
  }
}

export function compareStates(recorded: ReplayState, now: ReplayState): ReplayVerdict {
  const diff = RANK[now] - RANK[recorded];
  return diff === 0 ? 'same' : diff > 0 ? 'tighter' : 'looser';
}

/** The words for a state, as a person says them. */
export const STATE_WORDS: Record<ReplayState, string> = {
  allowed: 'went through',
  redacted: 'went through with parts hidden',
  waits_for_person: 'waited for a person',
  refused: 'was stopped',
};

export interface Judgement {
  now: ReplayState | null;
  verdict: ReplayVerdict;
  explanation: string;
}

const skipped = (explanation: string): Judgement => ({ now: null, verdict: 'not_replayed', explanation });

function judged(recorded: ReplayState, now: ReplayState, same: string, changed: string): Judgement {
  const verdict = compareStates(recorded, now);
  return { now, verdict, explanation: verdict === 'same' ? same : changed };
}

const stageOf = (d: RecordedDecision): string => (typeof d.detail['stage'] === 'string' ? d.detail['stage'] : 'none');

/** The gate: stage one only, on the message as the viewer can read it now. */
export function judgeGate(d: RecordedDecision, recorded: ReplayState, message: MessageNow | undefined, gate: GateNow): Judgement {
  if (d.outcome === 'refused') return skipped('A spending or rate limit stopped this one, not the topic list, and the limits of that day are not kept.');
  if (gate.kind === 'unreadable') return skipped("The bot's current settings could not be read, so its topic list cannot be applied.");
  if (gate.kind === 'none') {
    // A gate line is only written for a bot that had a topic list when it ran, so "none" now means the list was taken out since.
    return judged(
      recorded,
      'allowed',
      'The bot has no topic list now, and this message went straight through then.',
      'The bot has no topic list now, so this message would go straight through. It waited for a person when the bot had a list.',
    );
  }
  if (gate.kind === 'invalid') {
    return judged(recorded, 'waits_for_person', 'Everything waited for a person then too.', 'The bot’s topic list does not load now, so every message would wait for a person until it is fixed.');
  }
  if (!message || message.kind === 'unreadable') return skipped('The message is gone or you may not read it, so it cannot be checked again.');
  if (message.kind === 'edited') return skipped('The message was edited after the bot read it, so today’s text is not what the bot saw.');
  const hit = matchGate(gate.compiled, message.text);
  if (hit) {
    return judged(
      recorded,
      'waits_for_person',
      'Today’s topic list holds this message for a person, as it did then.',
      'Today’s topic list would hold this message for a person. It went through when the bot ran.',
    );
  }
  // No entry of today's list matches. What the local model decided on topics cannot be asked again for free.
  const wasLocalCheck = stageOf(d) === 'classifier' || stageOf(d) === 'classifier_unavailable';
  if (recorded === 'waits_for_person' && wasLocalCheck) {
    return skipped('The bot’s local model made this call on the topics, and a free replay cannot ask it again. Nothing in today’s word list matches.');
  }
  const caveat = gate.topics > 0 ? ' The local model’s check of the topics is not repeated.' : '';
  return judged(
    recorded,
    'allowed',
    `No entry of today’s topic list matches, as then.${caveat}`,
    `No entry of today’s topic list matches this message any more, so it would not wait for a person.${caveat}`,
  );
}

/** The guard before a model call: the workspace's preset, as it is today. */
export function judgeGuard(d: RecordedDecision, recorded: ReplayState, preset: string | null): Judgement {
  if (d.subject === 'mcp') return skipped('This was the data check on what a tool call carried. What it found is not kept, so it cannot be run again.');
  const reason = typeof d.detail['reason'] === 'string' ? d.detail['reason'] : null;
  const was = typeof d.detail['preset'] === 'string' ? d.detail['preset'] : null;
  if (reason === 'budget' || reason === 'rate') return skipped('A spending or rate limit stopped this call, and the limits of that day are not kept.');
  if (preset === null || !(preset in LLM_GUARD_PRESETS)) return skipped('The workspace’s guard setting could not be read.');
  const now = preset as LlmGuardPreset;
  const model = plainAlias(d.subject);
  if (now === 'air-gapped' && d.subject !== 'local') {
    return judged(recorded, 'refused', 'The workspace was air-gapped then too, so only the local model could be called.', `The workspace is air-gapped now, so the ${model} could not be called (only the local model can). The call ${STATE_WORDS[recorded]} then.`);
  }
  if (reason === 'preset') {
    if (was === now) return judged(recorded, recorded, 'The workspace uses the same guard setting as then.', '');
    if (was === 'air-gapped') {
      return judged(recorded, 'allowed', '', `The workspace was air-gapped then and is not now, so a call to the ${model} would no longer be stopped for that reason.`);
    }
    return skipped('A guard setting stopped this call and it has changed since; the exact rule is not kept.');
  }
  if (d.outcome === 'redact' || d.outcome === 'block') {
    // a detection: what happens to it follows the preset
    const next: ReplayState = LLM_GUARD_PRESETS[now].onDetection === 'block' ? 'refused' : 'redacted';
    return judged(
      recorded,
      next,
      'The workspace’s guard setting treats a detected secret the same way as then.',
      next === 'refused'
        ? 'The workspace now refuses a call that carries a detected secret instead of hiding it, so this call would be stopped.'
        : 'The workspace now hides a detected secret instead of refusing the call, so this call would go through with it hidden.',
    );
  }
  // 'require_approval' follows the bot's own setting, and 'allow' found nothing: both stand
  return judged(recorded, recorded, 'Nothing about the workspace’s guard setting changes this one.', '');
}

/** A tool call at the door, asked again of the broker with today's grants. */
export function judgeTool(d: RecordedDecision, recorded: ReplayState, now: ToolNow | undefined): Judgement {
  // A call that named more places than the record keeps (or places that were not kept) can only be asked again in part, and a part is never allowed to say "same" or "looser".
  if (d.detail['truncated'] === true) return skipped('The call named more places than were kept in the record, so it cannot be asked again as it was.');
  if (now && 'tooMany' in now) return skipped('Not checked: this replay already asked about too many different requests. Choose a shorter window to check the rest.');
  if (!now || 'unavailable' in now) return skipped('The bot’s current permissions could not be checked for this one.');
  const next: ReplayState = !now.allowed ? 'refused' : now.needsApproval ? 'waits_for_person' : 'allowed';
  const what = plainTool(d.subject);
  return judged(
    recorded,
    next,
    `Today’s permissions treat “${what}” the same way as then.`,
    next === 'allowed'
      ? `With today’s permissions the bot could ${what} here without asking; it ${STATE_WORDS[recorded]} then.`
      : next === 'refused'
        ? `With today’s permissions the bot would not be allowed to ${what} here; it ${STATE_WORDS[recorded]} then.`
        : `With today’s permissions a person would have to approve this: ${what}. It ${STATE_WORDS[recorded]} then.`,
  );
}

/** What a decision was about, in words. */
export function whatOf(d: RecordedDecision): string {
  if (d.kind === 'gate') return 'the bot’s topic list';
  if (d.kind === 'guard') return d.subject === 'mcp' ? 'the data check on a tool call' : `the data check before a call to the ${plainAlias(d.subject).replace(/ model$/, '')} model`;
  return `a request to ${plainTool(d.subject)}`;
}

const emptyCounts = (): ReplayCounts => ({ total: 0, same: 0, tighter: 0, looser: 0, notReplayed: 0 });

function count(into: ReplayCounts, verdict: ReplayVerdict): void {
  into.total += 1;
  if (verdict === 'same') into.same += 1;
  else if (verdict === 'tighter') into.tighter += 1;
  else if (verdict === 'looser') into.looser += 1;
  else into.notReplayed += 1;
}

export interface ReplayFacts {
  decisions: readonly RecordedDecision[];
  /** The text of each message a gate decision read, by id. */
  messages: ReadonlyMap<string, MessageNow>;
  gate: GateNow;
  /** The workspace's guard preset today, or null when it could not be read. */
  preset: string | null;
  /** The broker's answer for a tool decision (the key is `toolKey`), if it could be asked. */
  tools: ReadonlyMap<string, ToolNow>;
}

export const toolKey = (d: RecordedDecision): string => JSON.stringify([d.subject, d.detail['path'] ?? null, d.detail['paths'] ?? null, d.trigger]);

/** The honest limits, shown with every result. */
export const REPLAY_NOTES = [
  'Nothing was sent to a model and nothing was done: this only asks today’s rules the same questions.',
  'The bot’s local model is not asked again, so a message it held for a person stays as it was.',
  'What the data check found in a call is not kept (it would be the secret itself), so it is judged by the workspace’s guard setting only.',
  'Messages are read as they are now, with your own access: one you cannot read, or that was edited or deleted, is listed as not replayed.',
] as const;

export function evaluate(facts: ReplayFacts): Pick<ReplayResult, 'counts' | 'byKind' | 'changes' | 'changesCapped'> {
  const counts = emptyCounts();
  const byKind = { gate: emptyCounts(), guard: emptyCounts(), tool: emptyCounts() };
  const changes: ReplayChange[] = [];
  let changed = 0;
  for (const d of facts.decisions) {
    const recorded = recordedState(d.kind, d.outcome);
    // an outcome that cannot belong to its kind (a corrupt line): counted as not replayed, never guessed at
    const j: Judgement =
      recorded === null
        ? skipped('This record is not one the replay understands.')
        : d.kind === 'gate'
          ? judgeGate(d, recorded, d.messageId ? facts.messages.get(d.messageId) : undefined, facts.gate)
          : d.kind === 'guard'
            ? judgeGuard(d, recorded, facts.preset)
            : judgeTool(d, recorded, facts.tools.get(toolKey(d)));
    count(counts, j.verdict);
    count(byKind[d.kind], j.verdict);
    if (j.verdict === 'same') continue;
    changed += 1;
    if (changes.length < REPLAY_MAX_CHANGES) {
      changes.push({
        runId: d.runId as ReplayChange['runId'],
        at: d.at as ReplayChange['at'],
        kind: d.kind,
        what: whatOf(d),
        recorded: recorded ?? 'allowed',
        now: j.now,
        verdict: j.verdict,
        explanation: j.explanation,
      });
    }
  }
  // newest first
  changes.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return { counts, byKind, changes, changesCapped: changed > changes.length };
}
