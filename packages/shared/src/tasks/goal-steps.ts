import type { GoalCardRef, GoalStatus, TaskState } from '../entities/task.ts';

// The plan card's one rule: where a goal stands, worked out from its steps and the history of its cards (PLAN P22-03, docs/plans/phase-22-plan.md "Step state rule").
// A step is NOT a card. The goal stores the steps (title and the bots that do each one); whether a step is done is never stored, it is read off the cards:
// one card travels the chain of bots by handoffs (a handoff is passing a card to another bot or a person), and the bots that held it say which step it is in.
// Pure: no clock, no database; the server's `tasks.goal` read gathers the facts and calls this, and the same answer builds the one-line text of the card.

/** What the rule needs of a step: its words stay in the stored plan; here only the bots (by slug) and which card the step follows. */
export interface GoalStepSpec {
  bots: readonly string[];
  /** Which of the goal's cards the step follows; `work` when left out. */
  cardRef?: GoalCardRef | undefined;
}

/** What the rule needs of one card of the goal. */
export interface GoalCardFacts {
  state: TaskState;
  blockerReason: string;
  /**
   * Everyone who held the card, oldest first, as a bot slug, or null for a person (or a bot nobody could name). The creator is first, then the receiver of each
   * applied handoff; the current owner is last. Two holders in a row may be the same bot.
   */
  holders: readonly (string | null)[];
}

export type GoalStepStatus = 'todo' | 'running' | 'waiting' | 'blocked' | 'done';
export type GoalChip = 'planned' | 'running' | 'waiting for a person' | 'done' | 'stopped';

export interface GoalStepState {
  status: GoalStepStatus;
  /** Times the card came back into this step's bots from a later step (a reviewer sent it back to the coder). */
  rework: number;
}

export interface GoalStepsInput {
  goalStatus: GoalStatus;
  steps: readonly GoalStepSpec[];
  /** The goal's cards by role; a role with no card yet is left out. */
  cards: Partial<Record<GoalCardRef, GoalCardFacts>>;
}

export interface GoalStepsResult {
  steps: GoalStepState[];
  chip: GoalChip;
  /** The step to look at now, counted from 1: the first one not done. All done: the last step. 0 when the goal has no steps. */
  stepNow: number;
  stepCount: number;
}

/** The short name of a goal: number 27 is `G-27`. */
export const goalRef = (number: number): string => `G-${String(number)}`;

/**
 * Which role a card plays for the plan, from its title (the Engineer's naming): `Plan: …` and `Plan review: …` are the plan card, `Publish: …` the card that
 * opens the pull request, anything else is the work card.
 */
export function cardRefOfTitle(title: string): GoalCardRef {
  const t = title.trimStart().toLowerCase();
  if (/^plan( review)?\s*:/.test(t)) return 'plan';
  if (/^publish\s*:/.test(t)) return 'publish';
  return 'work';
}

/** The steps that follow one role of card, with their place in the whole list. */
function group(steps: readonly GoalStepSpec[], role: GoalCardRef): number[] {
  const out: number[] = [];
  steps.forEach((s, i) => {
    if ((s.cardRef ?? 'work') === role) out.push(i);
  });
  return out;
}

/**
 * Walks one card's holders over the steps that follow it. The pointer `furthest` is the furthest step any holder belonged to; `at` is the step of the CURRENT holder
 * (null when that holder belongs to no step: the Engineer between two steps, a person). A bot listed in two steps counts for the first one at or after `furthest`
 * (else the last one before it). Rework of a step is counted in two cases: the card arrives at a step earlier than `furthest` (a reviewer in a later step sent it
 * back, also through the Engineer), or it arrives at a bot of a step that comes earlier in the step's own list than a bot that already held it in that step
 * (`[coder, code-reviewer]`: coder, reviewer, coder is one rework).
 */
function walk(steps: readonly GoalStepSpec[], positions: readonly number[], card: GoalCardFacts): GoalStepState[] {
  const out: GoalStepState[] = positions.map(() => ({ status: 'todo' as GoalStepStatus, rework: 0 }));
  if (positions.length === 0) return out;
  if (card.state === 'done') return out.map(() => ({ status: 'done' as GoalStepStatus, rework: 0 }));
  let furthest = -1;
  let at: number | null = null;
  const botFurthest: number[] = positions.map(() => -1); // the latest bot (by its place in the step's list) that held the card inside each step
  for (let i = 0; i < card.holders.length; i += 1) {
    const holder = card.holders[i] ?? null;
    if (i > 0 && holder === card.holders[i - 1]) continue; // the same holder twice in a row is one stay
    const candidates: number[] = [];
    for (let p = 0; p < positions.length; p += 1) {
      if (holder !== null && steps[positions[p]!]?.bots.includes(holder)) candidates.push(p);
    }
    if (candidates.length === 0) {
      at = null;
      continue;
    }
    const forward = candidates.find((p) => p >= furthest);
    const place = forward ?? candidates[candidates.length - 1]!;
    const botIndex = steps[positions[place]!]?.bots.indexOf(holder as string) ?? -1;
    if (place < furthest || (place === furthest && botIndex < botFurthest[place]!)) out[place]!.rework += 1;
    botFurthest[place] = place < furthest ? botIndex : Math.max(botFurthest[place]!, botIndex);
    furthest = Math.max(furthest, place);
    at = place;
  }
  const waiting = card.state === 'waiting_on_person';
  const blocked = !waiting && card.blockerReason.trim() !== '';
  if (at !== null) {
    for (let p = 0; p < at; p += 1) out[p]!.status = 'done';
    out[at]!.status = waiting ? 'waiting' : blocked ? 'blocked' : 'running';
    return out;
  }
  if (furthest < 0) return out;
  // The card is with someone who is in no step (the Engineer, a person): the furthest step it reached is finished, unless the card waits on a person.
  for (let p = 0; p <= furthest; p += 1) out[p]!.status = 'done';
  if (waiting) out[furthest]!.status = 'waiting';
  else if (blocked) out[furthest]!.status = 'blocked'; // a blocker on a card that sits with the Engineer still marks the step it came from
  return out;
}

/** The state of every step of a goal, and the goal's chip, from its stored steps and the facts of its cards. */
export function goalSteps(input: GoalStepsInput): GoalStepsResult {
  const result: GoalStepState[] = input.steps.map(() => ({ status: 'todo', rework: 0 }));
  for (const role of ['plan', 'work', 'publish'] as const) {
    const positions = group(input.steps, role);
    const card = input.cards[role];
    if (!card) continue;
    walk(input.steps, positions, card).forEach((state, p) => {
      result[positions[p]!] = state;
    });
  }
  const count = result.length;
  const firstOpen = result.findIndex((s) => s.status !== 'done');
  const allDone = count > 0 && firstOpen === -1;
  const chip: GoalChip =
    input.goalStatus === 'dropped'
      ? 'stopped'
      : input.goalStatus === 'done' || allDone
        ? 'done'
        : result.some((s) => s.status === 'waiting')
          ? 'waiting for a person'
          : result.some((s) => s.status === 'running' || s.status === 'blocked' || s.status === 'done')
            ? 'running'
            : 'planned';
  return { steps: result, chip, stepNow: count === 0 ? 0 : firstOpen === -1 ? count : firstOpen + 1, stepCount: count };
}

/** The words at the right of a step: nothing for a step not started, `rework 1` while a step is being done again. */
export function stepWords(state: GoalStepState): string {
  if (state.status === 'todo') return '';
  if (state.status === 'running' && state.rework > 0) return `rework ${String(state.rework)}`;
  return state.status;
}

/** The dot of a step: green done, amber under way (or waiting), red blocked, grey not started. */
export function stepDot(state: GoalStepState): 'done' | 'running' | 'todo' | 'blocked' {
  if (state.status === 'done') return 'done';
  if (state.status === 'blocked') return 'blocked';
  if (state.status === 'todo') return 'todo';
  return 'running';
}

/** The plain line for a client that cannot draw the card: `Goal G-27 · running · step 2 of 6`. */
export function goalLine(ref: string, answer: Pick<GoalStepsResult, 'chip' | 'stepNow' | 'stepCount'>): string {
  const base = `Goal ${ref} · ${answer.chip}`;
  if (answer.stepCount === 0) return base;
  const done = answer.chip === 'done' || answer.chip === 'stopped';
  return done ? `${base} · ${String(answer.stepCount)} ${answer.stepCount === 1 ? 'step' : 'steps'}` : `${base} · step ${String(answer.stepNow)} of ${String(answer.stepCount)}`;
}
