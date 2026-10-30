import { z } from 'zod';
import { EvalMode, EvalRun } from '../../entities/eval.ts';
import { TeamSlug } from '../teams/common.ts';
import { BotSlug } from './pairing.ts';

// A bot's evals over HTTP (PLAN P7-08): a lead or workspace admin runs the scenario set on demand, any member of the team reads the latest runs.
// The set file itself is `bots/<slug>/evals/<set>.yaml` in the team repo; only its verdicts are stored here.

export const BotEvalsPathParams = z.object({ slug: TeamSlug, botSlug: BotSlug });
export type BotEvalsPathParams = z.infer<typeof BotEvalsPathParams>;

/**
 * Start a run. `static` (the default) is free and judges only what a definition decides; `model` sends the bot's prompt and each case's world to the
 * model and costs tokens. The run is queued: the answer is the run in state `running`, and the tab reads it again until it finishes.
 */
export const RunEvalsRequest = z.strictObject({ mode: EvalMode.default('static') });
export type RunEvalsRequest = z.infer<typeof RunEvalsRequest>;
export const RunEvalsResponse = z.object({ run: EvalRun });
export type RunEvalsResponse = z.infer<typeof RunEvalsResponse>;
export const runEvalsRoute = { method: 'POST', path: '/api/teams/:slug/bots/:botSlug/evals/run' } as const;

/** The most recent runs of the bot, newest first, without the per-case results except on `latest`. */
export const GetBotEvalsResponse = z.object({
  /** The set BOT.md names right now, and its minimum; null when the definition names none. */
  set: z.object({ name: z.string(), minScore: z.number().min(0).max(1) }).nullable(),
  /** The newest run that finished, with every case; null before the first run. */
  latest: EvalRun.nullable(),
  /** The newest runs (up to 10), summary only (`results` is empty). */
  recent: z.array(EvalRun).max(10),
  /** Whether the signed-in person may start a run (a lead of the team or a workspace admin). */
  canRun: z.boolean(),
});
export type GetBotEvalsResponse = z.infer<typeof GetBotEvalsResponse>;
export const getBotEvalsRoute = { method: 'GET', path: '/api/teams/:slug/bots/:botSlug/evals' } as const;
