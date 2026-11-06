import { z } from 'zod';
import { ActorId, TaskId, TeamId } from '../../ids.ts';
import { TeamSlug } from '../teams/common.ts';

/** `running`: the bot has a run in progress on the card. `queued`: a run for the card is waiting to start. */
export const CardBotPhase = z.enum(['running', 'queued']);
export type CardBotPhase = z.infer<typeof CardBotPhase>;

export const CardActivityPathParams = z.object({ slug: TeamSlug });
export type CardActivityPathParams = z.infer<typeof CardActivityPathParams>;

/**
 * Which bots are working on which cards of a team, for the board's bot icon. Only cards the caller can read appear. It names bots by actor id;
 * the client takes the names from the roster it already shows. At most 200 cards.
 */
export const CardActivityResponse = z.object({
  items: z.array(
    z.strictObject({
      taskId: TaskId,
      bots: z.array(z.strictObject({ actorId: ActorId, phase: CardBotPhase })).min(1),
    }),
  ),
});
export type CardActivityResponse = z.infer<typeof CardActivityResponse>;
export const cardActivityRoute = { method: 'GET', path: '/api/teams/:slug/tasks/activity' } as const;

/** A push to the people of a team: bots started or stopped working on some card. A hint to read `cardActivityRoute` again; it names no card. */
export const CardActivityChangedPush = z.object({ teamId: TeamId });
export type CardActivityChangedPush = z.infer<typeof CardActivityChangedPush>;
export const cardActivityChangedPushType = 'tasks.activity.changed' as const;
