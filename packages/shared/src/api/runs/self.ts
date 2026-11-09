import { z } from 'zod';
import { RunId } from '../../ids.ts';
import { BotSlug } from '../bots/pairing.ts';
import { TeamSlug } from '../teams/common.ts';

// Who a run is (PLAN Bundle E, WP-R1, docs/plugins/claude-pods.md). The publisher container of a Claude or Codex pod presents the run's own token
// (`Authorization: Bearer <run token>`, the one the run already uses to call the platform's tools) and learns which team, bot and run it belongs to. The
// publisher takes the folder to publish from this answer and never from the caller's words. The answer holds no token and no address.

export const RunSelfResponse = z.object({
  teamSlug: TeamSlug,
  botSlug: BotSlug,
  runId: RunId,
  /** The bot's definition grants `tasks.pull_request`: only then may the run publish a branch. */
  mayPublish: z.boolean(),
});
export type RunSelfResponse = z.infer<typeof RunSelfResponse>;
export const runSelfRoute = { method: 'GET', path: '/api/runs/self' } as const;
