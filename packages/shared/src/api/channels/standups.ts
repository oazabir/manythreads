import { z } from 'zod';
import { ChannelId } from '../../ids.ts';

/*
 * Async stand-ups (P18-04): a lead turns one on for a channel. Each member of the team is asked in their conversation with the stand-up bot when their own
 * working day starts, on the stand-up's days, unless they are out of office or on Do not disturb; one digest goes to the channel each day.
 */
export const StandupParams = z.object({ channelId: ChannelId });
export const StandupQuestion = z.string().trim().min(3).max(300);
export const Standup = z.object({
  enabled: z.boolean(),
  /** The bot that asks: one of the team's bots, by slug. */
  botSlug: z.string(),
  questions: z.array(StandupQuestion).min(1).max(5),
  /** Also ask for a number from 1 to 5 for how the week feels; the digest shows only the counts. */
  pulse: z.boolean(),
  /** ISO weekdays, 1 = Monday … 7 = Sunday. */
  days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  /** When the digest is posted, "HH:MM" in UTC (or sooner, when everyone asked has answered). */
  digestAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});
export type Standup = z.infer<typeof Standup>;
export const StandupResponse = z.object({ standup: Standup.nullable(), canManage: z.boolean() });
export type StandupResponse = z.infer<typeof StandupResponse>;
export const SaveStandupRequest = Standup;
export type SaveStandupRequest = z.infer<typeof SaveStandupRequest>;
export const getStandupRoute = { method: 'GET', path: '/api/channels/:channelId/standup' } as const;
export const saveStandupRoute = { method: 'PUT', path: '/api/channels/:channelId/standup' } as const;

/** The questions a new stand-up starts with. */
export const DEFAULT_STANDUP_QUESTIONS = ['What did you finish since the last stand-up?', 'What will you do today?', 'Is anything blocking you?'] as const;
