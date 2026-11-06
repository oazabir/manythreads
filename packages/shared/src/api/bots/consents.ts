import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { BotId } from '../../ids.ts';
import type { ApiRoute } from '../client/route.ts';
import { BotSlug } from './pairing.ts';

// Which bots may read a person's Personal space (P20-09, D10). Brain may read the Personal space of whoever asks it, unless that person turns it off. Any other
// bot needs the `personal.read` capability in its BOT.md AND the person's own yes on their Account page. A no, or a yes that is withdrawn, is enforced on the
// bot's next tool call. docs/plugins/bots.md.

/** The capability a bot's `BOT.md` lists under `capabilities.native` to be allowed to ask for a person's yes. It names no tool: the gateway reads it. */
export const PERSONAL_READ_CAPABILITY = 'personal.read';

/**
 * One bot as the person's consent page lists it. `canAsk` is false for a bot whose definition does not list `personal.read`: it cannot read Personal whatever the
 * person says, so the page shows it as "not asking". `allowed` is the person's answer, or the default when they have given none (`isDefault`): yes for Brain, no for
 * every other bot.
 */
export const BotPersonalConsent = z.object({
  botId: BotId,
  botSlug: BotSlug,
  botName: z.string().min(1),
  canAsk: z.boolean(),
  allowed: z.boolean(),
  isDefault: z.boolean(),
  changedAt: IsoDateTime.nullable(),
});
export type BotPersonalConsent = z.infer<typeof BotPersonalConsent>;

export const ListBotConsentsResponse = z.object({ items: z.array(BotPersonalConsent) });
export type ListBotConsentsResponse = z.infer<typeof ListBotConsentsResponse>;
export const listBotConsentsRoute = { method: 'GET', path: '/api/me/bot-consents' } as const satisfies ApiRoute;

export const SetBotConsentParams = z.object({ botId: BotId });
export type SetBotConsentParams = z.infer<typeof SetBotConsentParams>;
export const SetBotConsentRequest = z.strictObject({ allowed: z.boolean() });
export type SetBotConsentRequest = z.infer<typeof SetBotConsentRequest>;
export const SetBotConsentResponse = z.object({ item: BotPersonalConsent });
export type SetBotConsentResponse = z.infer<typeof SetBotConsentResponse>;
export const setBotConsentRoute = { method: 'PUT', path: '/api/me/bot-consents/:botId' } as const satisfies ApiRoute;
