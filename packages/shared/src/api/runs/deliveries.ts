import { z } from 'zod';

// P35-05: the delivery dashboard. A delivery is a thread where a person (or a GitHub issue, P35-04) asked a team's bots for work: the runs, cards, approvals
// and pull requests in that thread, and the people's replies after the request (the nudges a delivery needed). Spend is the model gateway's, for the
// workspace's admins only; a run on a Claude or Codex subscription has no spend line, so its time is what it cost.

export const DeliveriesQuery = z.object({ days: z.coerce.number().int().min(1).max(31).default(7) });
export type DeliveriesQuery = z.infer<typeof DeliveriesQuery>;

export const Delivery = z.object({
  rootId: z.uuid(),
  channelId: z.uuid(),
  channelName: z.string(),
  /** The request's first line. */
  title: z.string(),
  startedAt: z.string(),
  /** When the last of its cards was finished, once all are; null while work is open or there is no card. */
  finishedAt: z.string().nullable(),
  minutes: z.number().nullable(),
  runs: z.number().int(),
  failedRuns: z.number().int(),
  runMinutes: z.number(),
  bots: z.array(z.string()),
  cards: z.number().int(),
  doneCards: z.number().int(),
  pullRequests: z.array(z.object({ number: z.number().int(), url: z.string().nullable(), state: z.string() })),
  approvals: z.number().int(),
  nudges: z.number().int(),
  /** Null when the caller may not read spend (only workspace admins may). */
  spendUsd: z.number().nullable(),
});
export type Delivery = z.infer<typeof Delivery>;

export const BotWeek = z.object({
  slug: z.string(),
  name: z.string(),
  /** The runner the bot's definition names now (`placement.runs_on`); runs do not record theirs. */
  runner: z.string().nullable(),
  runs: z.number().int(),
  failedRuns: z.number().int(),
  avgMinutes: z.number(),
  spendUsd: z.number().nullable(),
});
export type BotWeek = z.infer<typeof BotWeek>;

export const DeliveriesResponse = z.object({ days: z.number().int(), deliveries: z.array(Delivery), bots: z.array(BotWeek) });
export type DeliveriesResponse = z.infer<typeof DeliveriesResponse>;
export const deliveriesRoute = { method: 'GET', path: '/api/teams/:slug/deliveries' } as const;
