import { z } from 'zod';
import { ANALYTICS_USAGE_DAYS, AnswerQuality, UsageAliasRow, UsageBotRow, UsageBudget, UsageDay, UsageRange, UsageSignIns, UsageTeamRow, UsageTotals } from '../../entities/analytics.ts';
import { Team } from '../../entities/team.ts';
import { BotId, TeamId } from '../../ids.ts';
import { BotSlug } from '../bots/pairing.ts';
import type { ApiRoute } from '../client/route.ts';

// The usage pages (PLAN P8-11): what the workspace, one team and one bot did over the last days, in counts and amounts. Never what was said or read.
// A workspace owner or admin reads everything, money included; a team member reads the numbers of the teams they belong to, without money; a guest reads nothing.

const TeamSlug = Team.shape.slug;

/** How far back to look: whole UTC days ending today. */
export const UsageQuery = z.object({
  days: z.coerce.number().int().min(ANALYTICS_USAGE_DAYS.min).max(ANALYTICS_USAGE_DAYS.max).default(ANALYTICS_USAGE_DAYS.default),
});
export type UsageQuery = z.infer<typeof UsageQuery>;

/** The part every usage page shares. */
const usageBody = {
  range: UsageRange,
  totals: UsageTotals,
  /** One entry per day of the range, oldest first, including days with nothing. */
  daily: z.array(UsageDay),
  /** Spend by model alias (`smart`, `fast`, ...); empty for a reader who may not see money. */
  spendByAlias: z.array(UsageAliasRow),
  quality: AnswerQuality,
  /** The budget that applies to this page's subject, with its window's spend; null when none is set or the reader is not an admin. */
  budget: UsageBudget.nullable(),
  /** When the numbers were read. */
  generatedAt: z.iso.datetime({ offset: true }),
};

export const WorkspaceUsageResponse = z.object({
  ...usageBody,
  teams: z.array(UsageTeamRow),
  bots: z.array(UsageBotRow),
  signIns: UsageSignIns,
});
export type WorkspaceUsageResponse = z.infer<typeof WorkspaceUsageResponse>;
export const workspaceUsageRoute = { method: 'GET', path: '/api/workspace/usage' } as const satisfies ApiRoute;

export const TeamUsagePathParams = z.object({ slug: TeamSlug });
export type TeamUsagePathParams = z.infer<typeof TeamUsagePathParams>;
export const TeamUsageResponse = z.object({
  ...usageBody,
  team: z.object({ id: TeamId, slug: TeamSlug, name: z.string() }),
  bots: z.array(UsageBotRow),
  /** The team's Brain, when it has one (the bot whose slug is `brain`); its page is the "Brain quality" part. */
  brainSlug: z.string().nullable(),
});
export type TeamUsageResponse = z.infer<typeof TeamUsageResponse>;
export const teamUsageRoute = { method: 'GET', path: '/api/teams/:slug/usage' } as const satisfies ApiRoute;

export const BotUsagePathParams = z.object({ slug: TeamSlug, botSlug: BotSlug });
export type BotUsagePathParams = z.infer<typeof BotUsagePathParams>;
export const BotUsageResponse = z.object({
  ...usageBody,
  team: z.object({ id: TeamId, slug: TeamSlug, name: z.string() }),
  bot: z.object({ id: BotId, slug: z.string(), name: z.string() }),
});
export type BotUsageResponse = z.infer<typeof BotUsageResponse>;
export const botUsageRoute = { method: 'GET', path: '/api/teams/:slug/bots/:botSlug/usage' } as const satisfies ApiRoute;
