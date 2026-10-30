import { z } from 'zod';
import { BotEvalCase } from '../bot-md/evals.ts';
import { IsoDateTime } from '../common/time.ts';
import { BotEvalRunId } from '../ids.ts';

// A bot's evals as the harness and the Evals tab see them (PLAN P7-08, SPEC section 8). The scenario file itself (`BotEvalSet`, `BotEvalCase`) is
// in bot-md/evals.ts; what is here is what a RUN of it produces: the answer a bot gave to one case, the verdict on that case, and the run that
// holds the verdicts of a whole set.
//
// Two modes, because a model costs money and a commit should not:
//  - `static`  (free, deterministic): no model. The "answer" is built from the definition alone, so only what a definition decides can be judged:
//              the calls a case requires or forbids (`toolCalls`) are checked against the bot's granted capabilities. Every other assertion is
//              reported as not checked, never as passed.
//  - `model`   the bot's own prompt (the BOT.md body) is sent to the model with the case's world, and the reply is judged on every assertion.

export const EvalTrigger = z.enum(['on_demand', 'on_commit', 'nightly']);
export type EvalTrigger = z.infer<typeof EvalTrigger>;

export const EvalMode = z.enum(['static', 'model']);
export type EvalMode = z.infer<typeof EvalMode>;

/** `running` while the job works; `finished` when every case has a verdict; `failed` when the run itself could not be made (no model, a broken set file). */
export const EvalRunStatus = z.enum(['running', 'finished', 'failed']);
export type EvalRunStatus = z.infer<typeof EvalRunStatus>;

/** One scenario of a set: the file's own shape (`bots/<slug>/evals/<set>.yaml`). */
export const EvalCase = BotEvalCase;
export type EvalCase = z.infer<typeof EvalCase>;

const Word = z.string().min(1).max(64);

/**
 * What the bot did for one case, in the terms the assertions are written in (the contract is in bot-md/evals.ts): the text of the answer, what it
 * cites, what it says it could not reach, the hand-off chips, and the calls the run made. A model answerer fills it from the model's reply, the static
 * answerer from the definition. `judges` names the assertions this answer can be judged on; left out, every one.
 */
export const EvalAnswer = z.object({
  body: z.string().max(20_000),
  citations: z
    .array(z.object({ kind: Word, label: z.string().max(300).default(''), snippet: z.string().max(600).nullish(), masked: z.boolean().optional() }))
    .max(40)
    .default([]),
  outsideScope: z.object({ count: z.number().int().min(0).max(100), items: z.array(z.object({ kind: Word })).max(40) }).default({ count: 0, items: [] }),
  chips: z.array(z.object({ kind: Word, label: z.string().max(200).default(''), prompt: z.string().max(500).nullish() })).max(20).default([]),
  toolCalls: z.array(z.string().min(1).max(100)).max(100).default([]),
  judges: z.array(z.string().min(1).max(40)).max(20).optional(),
});
export type EvalAnswer = z.infer<typeof EvalAnswer>;

/** The verdict on one case. `judged` is false when nothing the case asserts could be checked in this mode: then it is neither passed nor failed. */
export const EvalResult = z.object({
  caseId: z.string().min(1).max(64),
  passed: z.boolean(),
  judged: z.boolean(),
  /** The share of the assertions that were checked and held (1 = all of them, 0 = none; 0 when nothing was checked). */
  score: z.number().min(0).max(1),
  /** One plain sentence per assertion that did not hold, or why the case was not judged. Empty for a case that passed. */
  reasons: z.array(z.string().max(400)).max(20),
  /** The assertions that could not be checked in this mode (named as in the set file: `mentions`, `minCitations`...). */
  skipped: z.array(z.string().max(40)).max(20),
  /** The first characters of the answer, for the person reading a failure. */
  answerExcerpt: z.string().max(400),
  durationMs: z.number().int().min(0),
  costTokens: z.number().int().min(0),
});
export type EvalResult = z.infer<typeof EvalResult>;

/** The most results one run keeps (a set has at most 100 cases). */
export const EVAL_RESULTS_MAX = 100;

/**
 * One run of a bot's scenario set. `total` is the number of cases, `judged` the number that could be checked, `passed` how many of those held;
 * `score` is passed / judged (null while running, or when nothing could be judged). `ok` is `score >= minScore` (null when there is no score):
 * `false` is what the Evals tab flags.
 */
export const EvalRun = z.object({
  id: BotEvalRunId,
  botSlug: z.string().min(1).max(64),
  set: z.string().min(1).max(64),
  /** The repo commit the definition and the set were read at; null for a run made from files on disk. */
  commitSha: z.string().regex(/^[0-9a-f]{40,64}$/).nullable(),
  trigger: EvalTrigger,
  mode: EvalMode,
  status: EvalRunStatus,
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime.nullable(),
  total: z.number().int().min(0),
  judged: z.number().int().min(0),
  passed: z.number().int().min(0),
  score: z.number().min(0).max(1).nullable(),
  minScore: z.number().min(0).max(1),
  ok: z.boolean().nullable(),
  costTokens: z.number().int().min(0),
  /** Why a `failed` run failed, in plain words; null otherwise. */
  error: z.string().max(1000).nullable(),
  results: z.array(EvalResult).max(EVAL_RESULTS_MAX),
});
export type EvalRun = z.infer<typeof EvalRun>;
