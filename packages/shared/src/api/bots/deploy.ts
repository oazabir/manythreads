import { z } from 'zod';
import { TeamSlug } from '../teams/common.ts';
import { PROPOSAL_MAX_CHARS } from '../proposals/index.ts';
import { BotSlug } from './pairing.ts';

// The bot page's Deploy action (PLAN P8-34, docs/plans/support-email-journey.md D2). One action that does three things and reports each: it commits the definition through the one
// repo writer, makes the knowledge bases the definition lists ready, and switches on the connections it uses. It is NOT a new state of the bot: the bot's liveness stays the
// loader's, a base's stays `knowledge_bases.status`, a connection's stays `connections.status`. A deploy that changed nothing says so and is not counted as one.

export const BotDeployPathParams = z.object({ slug: TeamSlug, botSlug: BotSlug });
export type BotDeployPathParams = z.infer<typeof BotDeployPathParams>;

/**
 * What to deploy. Left out, the definition in the team repo as it is now. With `content`, that text is committed first (the page's unsaved changes), written from the blob
 * `baseBlobSha` the page loaded: a file someone else changed meanwhile is refused, never overwritten.
 */
export const BotDeployRequest = z.strictObject({
  content: z.string().max(PROPOSAL_MAX_CHARS).optional(),
  baseBlobSha: z.string().regex(/^[0-9a-f]{40,64}$/).nullable().optional(),
});
export type BotDeployRequest = z.infer<typeof BotDeployRequest>;

export const BOT_DEPLOY_STEPS = ['definition', 'knowledge', 'connection'] as const;
export const BotDeployStep = z.enum(BOT_DEPLOY_STEPS);
export type BotDeployStep = z.infer<typeof BotDeployStep>;

/**
 * What one of the three came to. `changed`: it did something. `unchanged`: it was already as wanted. `not_used`: the definition uses none of this kind. `refused`: it could not be
 * done (`message` says why). `not_run`: an earlier step was refused, so this one was not attempted and nothing of it was changed.
 */
export const BotDeployState = z.enum(['changed', 'unchanged', 'not_used', 'refused', 'not_run']);
export type BotDeployState = z.infer<typeof BotDeployState>;

export const BotDeployOutcome = z.object({
  step: BotDeployStep,
  state: BotDeployState,
  /** One plain sentence about this step. Never a credential, a file's text or an address. */
  message: z.string().min(1).max(1000),
});
export type BotDeployOutcome = z.infer<typeof BotDeployOutcome>;

/**
 * Always the three outcomes, in order. `deployed` is true only when no step was refused and at least one changed something. A refusal found before anything was changed leaves every
 * other step `not_run`; a refusal found while doing leaves the earlier steps as they are (each was done as its owner does it) and says so.
 */
export const BotDeployResponse = z.object({
  deployed: z.boolean(),
  /** One sentence for the whole action. */
  summary: z.string().min(1).max(1000),
  outcomes: z.array(BotDeployOutcome).length(3),
});
export type BotDeployResponse = z.infer<typeof BotDeployResponse>;

export const deployBotRoute = { method: 'POST', path: '/api/teams/:slug/bots/:botSlug/deploy' } as const;
