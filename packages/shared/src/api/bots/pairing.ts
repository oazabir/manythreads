import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { TeamSlug } from '../teams/common.ts';

// The pairing routes (SPEC §7.6, PLAN P5-04): a lead mints the credential a bot's runtime presents instead of holding one, and turns every
// live token of the bot off. The token is returned once — only its sha256 is stored — and resolving it is not an HTTP round trip: the
// gateway of P5-09 and a rules run call `app.bots_pairing_resolve(sha256(token))` in their own transaction (docs/plugins/bots.md).

/** The slug of `bots/<slug>/BOT.md`, unique in the team (the folder name, the same shape as the row's CHECK). */
export const BotSlug = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'lowercase letters, digits, ".", "_" or "-"');

export const BotPairingPathParams = z.object({ slug: TeamSlug, botSlug: BotSlug });

/** Shown once: the raw token is never stored and never returned again. */
export const MintPairingTokenResponse = z.object({
  token: z.string().min(1),
  createdAt: IsoDateTime,
});
export type MintPairingTokenResponse = z.infer<typeof MintPairingTokenResponse>;

/** How many of the bot's live tokens the revoke turned off (0 when there were none). */
export const RevokePairingTokensResponse = z.object({ revoked: z.number().int().nonnegative() });
export type RevokePairingTokensResponse = z.infer<typeof RevokePairingTokensResponse>;

export const mintPairingTokenRoute = { method: 'POST', path: '/api/teams/:slug/bots/:botSlug/pairing-tokens' } as const;
export const revokePairingTokensRoute = { method: 'DELETE', path: '/api/teams/:slug/bots/:botSlug/pairing-tokens' } as const;
