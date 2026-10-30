import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { ActorId } from '../../ids.ts';
import { Bot, BotRun } from '../../entities/bot.ts';
import { TeamSlug } from '../teams/common.ts';
import { BotSlug } from './pairing.ts';

// The bot roster and one bot's page (SPEC §7.5, PLAN P5-05). A read surface: the definition itself is the repo's file, read and written
// through the repo routes (`repo/blob`, `repo/commit`). The editor inherits the guarded-path rules that way — a lead or admin commits
// `bots/` directly, a member's write is 403 and the UI offers a pull request instead. What is here is what a row of the roster and the
// bot page's banner need.

/**
 * A bot as the roster and the bot page read it: the row plus the two fields a roster cannot do without (`name`, `role`, copied out of
 * the definition by the loader), the compiled `mayTag`, and — when the last load failed — the reason, read from the row's
 * `invalid_reason` (bots migration 0006). The loader sets it on a failed load and clears it on the next good one, so a repaired file
 * carries none; `bots.bot.invalid` stays the team-readable alert and history, never the page's state.
 */
export const BotSummary = Bot.extend({
  /**
   * The bot's actor id: what a card's `ownerId`, a history line's `actorId` and a message's author carry (never `id`, which is the
   * bots row). Null only if the actor row is missing, which the loader never leaves.
   */
  actorId: ActorId.nullable(),
  name: z.string().min(1),
  role: z.string(),
  /** Compiled from `handover.mayTag`; empty when the definition names nobody. */
  mayTag: z.array(z.string()),
  /**
   * The definition lists a `conversation` trigger, so a message in a conversation with the bot is answered. A bot without one has no
   * conversation to open: `POST …/conversation` answers 409 `bot_has_no_conversation_trigger`, and the clients offer no Talk button.
   */
  conversational: z.boolean(),
  invalid: z
    .object({
      fieldPath: z.string().nullable(),
      message: z.string(),
      at: IsoDateTime,
      /** The definition that failed; the row's own `definitionSha` is the last good one. */
      definitionSha: z.string(),
    })
    .nullable(),
});
export type BotSummary = z.infer<typeof BotSummary>;

export const ListBotsPathParams = z.object({ slug: TeamSlug });
export type ListBotsPathParams = z.infer<typeof ListBotsPathParams>;

export const ListBotsResponse = z.object({ bots: z.array(BotSummary) });
export type ListBotsResponse = z.infer<typeof ListBotsResponse>;
export const listBotsRoute = { method: 'GET', path: '/api/teams/:slug/bots' } as const;

export const GetBotPathParams = z.object({ slug: TeamSlug, botSlug: BotSlug });
export type GetBotPathParams = z.infer<typeof GetBotPathParams>;

/** The bot page's data: the row, where its definition lives, and the runs the Audit tab lists. */
export const GetBotResponse = z.object({
  bot: BotSummary,
  /** The repo path of the definition the loader read: `bots/<slug>/BOT.md`. */
  path: z.string().min(1),
  /** Newest first, capped at 20. */
  runs: z.array(BotRun),
});
export type GetBotResponse = z.infer<typeof GetBotResponse>;
export const getBotRoute = { method: 'GET', path: '/api/teams/:slug/bots/:botSlug' } as const;

/** The bot's own definition path: one place builds it, so the loader, the editor and the page cannot disagree. */
export const botMdPath = (slug: string): string => `bots/${slug}/BOT.md`;

/** The folder name a bot may live under — the row's own CHECK, and what the roster's slug field validates. */
export const BOT_SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;
/** What the loader (and a proposal's BOT.md check) says about a bot folder whose name does not fit `BOT_SLUG_RE`. */
export const botSlugProblem = (slug: string): string => `folder "${slug}": a bot lives in a folder named with a lowercase slug (letters, digits, ".", "_", "-")`;