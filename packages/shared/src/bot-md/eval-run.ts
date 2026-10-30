import type { EvalAnswer, EvalMode, EvalResult } from '../entities/eval.ts';
import type { BotEvalCase, BotEvalExpect } from './evals.ts';

// The one place a scenario is run and judged (PLAN P7-08; phase 7 section 0: "extract a single run-a-scenario function"). The bots plugin's on-demand,
// on-commit and nightly runs, the `pnpm test:evals` command and the tests all call `runEvalScenario` / `runEvalSet`; none of them has a judge of its own.
// Pure: no clock, no network, no file. The model call is an `Answerer` that the caller passes in, so a test passes a fake and the free mode passes
// `staticAnswerer`. The meaning of every assertion is the contract written above `BotEvalExpect` in evals.ts.

/** What an answerer needs to know about the bot: the prompt (the BOT.md body) and the capabilities its definition grants. */
export interface EvalBotDefinition {
  slug: string;
  name: string;
  /** The body of BOT.md: the prompt itself. */
  body: string;
  /** `capabilities.native` as written (`messages.post`, `answer.*`). */
  native: readonly string[];
  /** The model alias the bot asks for first (`smart`, `fast`...), or null when the definition names none. */
  alias: string | null;
}

/** The answer to one case plus what it cost. A throw means the answerer could not answer at all (no model, a refused call): the whole run fails. */
export interface Answered {
  answer: EvalAnswer;
  tokens: number;
}

export interface Answerer {
  mode: EvalMode;
  answer(definition: EvalBotDefinition, scenario: BotEvalCase): Promise<Answered>;
}

/** Every assertion a set file can make (`toolCalls` is two: the calls it requires and the calls it forbids). */
export const EVAL_ASSERTIONS = [
  'minCitations',
  'maxCitations',
  'citesKinds',
  'mentions',
  'notMentions',
  'statesOutsideScope',
  'outsideScopeKinds',
  'statesUnknown',
  'offersHandoff',
  'toolCalls.required',
  'toolCalls.forbidden',
] as const;
export type EvalAssertion = (typeof EVAL_ASSERTIONS)[number];

const lower = (s: string): string => s.toLowerCase();

/** The text the "mentions"/"notMentions" assertions look in: the body, every citation's label and snippet, every chip, every outside-scope kind. */
function everyWord(a: EvalAnswer): string {
  const parts: string[] = [a.body];
  for (const c of a.citations) parts.push(c.label, c.snippet ?? '');
  for (const c of a.chips) parts.push(c.label, c.prompt ?? '');
  for (const i of a.outsideScope.items) parts.push(i.kind);
  return lower(parts.join('\n'));
}

/** `x.*` names a namespace; `x.y` one verb. Two names meet when either contains the other. */
export function capabilityMeets(a: string, b: string): boolean {
  const ns = (s: string): string | null => (s.endsWith('.*') ? s.slice(0, -2) : null);
  if (a === b) return true;
  const na = ns(a);
  const nb = ns(b);
  if (na !== null && (b === na || b.startsWith(`${na}.`))) return true;
  if (nb !== null && (a === nb || a.startsWith(`${nb}.`))) return true;
  return false;
}

const MARKER = /\[\d{1,3}\]/;

/** Which assertions of an expectation a case asks for, in the order of EVAL_ASSERTIONS. */
export function assertionsOf(expect: BotEvalExpect): EvalAssertion[] {
  return EVAL_ASSERTIONS.filter((k) => {
    if (k === 'toolCalls.required') return (expect.toolCalls?.required ?? []).length > 0;
    if (k === 'toolCalls.forbidden') return (expect.toolCalls?.forbidden ?? []).length > 0;
    return expect[k] !== undefined;
  });
}

interface Judged {
  /** Assertions that were checked, and the sentence for each that failed. */
  checked: number;
  failures: string[];
  skipped: string[];
}

/** Judge one expectation against one answer. Assertions the answer does not `judges` are skipped, never passed. */
export function judgeExpectation(expect: BotEvalExpect, answer: EvalAnswer): Judged {
  const judges = answer.judges === undefined ? null : new Set(answer.judges);
  const out: Judged = { checked: 0, failures: [], skipped: [] };
  const check = (key: string, present: boolean, holds: () => string | null): void => {
    if (!present) return;
    if (judges !== null && !judges.has(key)) {
      out.skipped.push(key);
      return;
    }
    out.checked += 1;
    const problem = holds();
    if (problem !== null) out.failures.push(problem);
  };
  const cited = answer.citations.filter((c) => c.masked !== true);
  const body = lower(answer.body);
  const words = everyWord(answer);

  check('minCitations', expect.minCitations !== undefined, () => (cited.length >= (expect.minCitations ?? 0) ? null : `It cited ${cited.length} source(s); at least ${expect.minCitations} were expected.`));
  check('maxCitations', expect.maxCitations !== undefined, () => (cited.length <= (expect.maxCitations ?? 0) ? null : `It cited ${cited.length} source(s); at most ${expect.maxCitations} were expected.`));
  check('citesKinds', expect.citesKinds !== undefined, () => {
    const missing = (expect.citesKinds ?? []).filter((k) => !cited.some((c) => c.kind === k));
    return missing.length === 0 ? null : `It did not cite a source of kind ${missing.map((k) => `"${k}"`).join(', ')}.`;
  });
  check('mentions', expect.mentions !== undefined, () => {
    const missing = (expect.mentions ?? []).filter((p) => !body.includes(lower(p)));
    return missing.length === 0 ? null : `The answer does not say ${missing.map((p) => `"${p}"`).join(', ')}.`;
  });
  check('notMentions', expect.notMentions !== undefined, () => {
    const present = (expect.notMentions ?? []).filter((p) => words.includes(lower(p)));
    return present.length === 0 ? null : `The answer must not contain ${present.map((p) => `"${p}"`).join(', ')}, but it does.`;
  });
  check('statesOutsideScope', expect.statesOutsideScope !== undefined, () => {
    const states = answer.outsideScope.count >= 1;
    if (states === expect.statesOutsideScope) return null;
    return states ? 'It listed things it could not reach, but this case expects none.' : 'It did not say what it could not reach.';
  });
  check('outsideScopeKinds', expect.outsideScopeKinds !== undefined, () => {
    const missing = (expect.outsideScopeKinds ?? []).filter((k) => !answer.outsideScope.items.some((i) => i.kind === k));
    return missing.length === 0 ? null : `It did not name ${missing.map((k) => `"${k}"`).join(', ')} among the things it could not reach.`;
  });
  check('statesUnknown', expect.statesUnknown !== undefined, () => {
    const claimsNothing = answer.citations.length === 0 && !MARKER.test(answer.body) && answer.body.trim() !== '';
    if (claimsNothing === expect.statesUnknown) return null;
    return claimsNothing ? 'It answered without pointing to any source, but this case expects it to point to one.' : 'It pointed to a source or gave no answer, but this case expects a plain statement that it does not know.';
  });
  check('offersHandoff', expect.offersHandoff !== undefined, () => {
    const offers = answer.chips.some((c) => c.kind === 'handoff');
    if (offers === expect.offersHandoff) return null;
    return offers ? 'It offered a hand-off, but this case expects none.' : 'It did not offer a hand-off to another bot.';
  });
  check('toolCalls.required', (expect.toolCalls?.required ?? []).length > 0, () => {
    const never = (expect.toolCalls?.required ?? []).filter((r) => !answer.toolCalls.some((c) => capabilityMeets(c, r)));
    return never.length === 0 ? null : `It never called ${never.join(', ')}.`;
  });
  check('toolCalls.forbidden', (expect.toolCalls?.forbidden ?? []).length > 0, () => {
    const hits = (expect.toolCalls?.forbidden ?? []).flatMap((f) => {
      const hit = answer.toolCalls.find((c) => capabilityMeets(c, f));
      return hit === undefined ? [] : [hit];
    });
    return hits.length === 0 ? null : `It called ${[...new Set(hits)].join(', ')}, which this case forbids.`;
  });
  return out;
}

const EXCERPT_CHARS = 300;
const excerptOf = (body: string): string => {
  const flat = body.replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length > EXCERPT_CHARS ? `${chars.slice(0, EXCERPT_CHARS - 1).join('')}…` : flat;
};

/**
 * Run one scenario: ask the answerer, judge the answer. `now` is the clock (milliseconds) so the caller's tests can fix it. A case none of whose
 * assertions can be checked in the answerer's mode comes back `judged: false` — not passed, not failed.
 */
export async function runEvalScenario(
  answerer: Answerer,
  definition: EvalBotDefinition,
  scenario: BotEvalCase,
  now: () => number = Date.now,
): Promise<EvalResult> {
  const started = now();
  const { answer, tokens } = await answerer.answer(definition, scenario);
  const judged = judgeExpectation(scenario.expect, answer);
  const durationMs = Math.max(0, Math.round(now() - started));
  const costTokens = Math.max(0, Math.round(tokens));
  if (judged.checked === 0) {
    return {
      caseId: scenario.id,
      passed: false,
      judged: false,
      score: 0,
      reasons: [`Not checked: ${judged.skipped.join(', ')} can only be judged with the model.`],
      skipped: judged.skipped,
      answerExcerpt: excerptOf(answer.body),
      durationMs,
      costTokens,
    };
  }
  const score = (judged.checked - judged.failures.length) / judged.checked;
  return {
    caseId: scenario.id,
    passed: judged.failures.length === 0,
    judged: true,
    score: Math.round(score * 1000) / 1000,
    reasons: judged.failures.slice(0, 20),
    skipped: judged.skipped,
    answerExcerpt: excerptOf(answer.body),
    durationMs,
    costTokens,
  };
}

export interface EvalSummary {
  total: number;
  judged: number;
  passed: number;
  /** passed / judged, three decimals; null when nothing could be judged. */
  score: number | null;
  /** `score >= minScore`; null when there is no score. */
  ok: boolean | null;
  costTokens: number;
}

/** Count the verdicts of a set against its minimum. A case is passed only when every assertion that could be checked held. */
export function summarizeEval(results: readonly EvalResult[], minScore: number): EvalSummary {
  const judged = results.filter((r) => r.judged).length;
  const passed = results.filter((r) => r.judged && r.passed).length;
  const score = judged === 0 ? null : Math.round((passed / judged) * 1000) / 1000;
  return {
    total: results.length,
    judged,
    passed,
    score,
    // 1e-9: 0.9 must hold for 9 of 10 whatever the float says
    ok: score === null ? null : score + 1e-9 >= minScore,
    costTokens: results.reduce((n, r) => n + r.costTokens, 0),
  };
}

/** Run every case of a set in order (one at a time: a model's rate limit and a run's cost are easier to bound that way). */
export async function runEvalSet(
  answerer: Answerer,
  definition: EvalBotDefinition,
  cases: readonly BotEvalCase[],
  minScore: number,
  now: () => number = Date.now,
): Promise<{ results: EvalResult[]; summary: EvalSummary }> {
  const results: EvalResult[] = [];
  for (const scenario of cases) results.push(await runEvalScenario(answerer, definition, scenario, now));
  return { results, summary: summarizeEval(results, minScore) };
}

/**
 * The free mode: no model. The bot's "calls" are the capabilities its definition grants. That is enough for one thing only: a case that REQUIRES a call
 * the definition does not grant can never pass. A granted capability says nothing about whether the bot would call it in a situation (Brain is granted
 * `messages.post` and must still not post in the case that forbids it), so "forbidden" calls and every assertion about words need the model and are
 * reported as not checked.
 */
export const staticAnswerer: Answerer = {
  mode: 'static',
  async answer(definition) {
    return {
      answer: { body: '', citations: [], outsideScope: { count: 0, items: [] }, chips: [], toolCalls: [...definition.native], judges: ['toolCalls.required'] },
      tokens: 0,
    };
  },
};
