import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { BRIDGE_CODE_DIGITS, BridgeAccount, BridgeAvailable, BridgeIdentity, BridgeLink, BridgeProvider } from '../../entities/bridge.ts';
import { BridgeAccountId, BridgeLinkId, ChannelId } from '../../ids.ts';
import type { ApiRoute } from '../client/route.ts';

// Chat bridges (PLAN Bundle D, P16-09, plugin `bridges`, docs/plugins/bridges.md). An admin connects a chat app account (credentials are sealed on the way in and no route
// returns them), a person links their own chat user with a code, and a lead joins a PUBLIC channel to an outside chat with a code typed there. Only linked people are ever
// heard. Every client body is strict.

export const BridgeProviderParams = z.object({ provider: BridgeProvider });
export type BridgeProviderParams = z.infer<typeof BridgeProviderParams>;
export const BridgeDoorParams = z.object({ provider: BridgeProvider, accountId: BridgeAccountId });
export type BridgeDoorParams = z.infer<typeof BridgeDoorParams>;
export const BridgeLinkParams = z.object({ linkId: BridgeLinkId });
export type BridgeLinkParams = z.infer<typeof BridgeLinkParams>;
export const BridgeChannelParams = z.object({ channelId: ChannelId });
export type BridgeChannelParams = z.infer<typeof BridgeChannelParams>;
export const BridgeChannelProviderParams = z.object({ channelId: ChannelId, provider: BridgeProvider });
export type BridgeChannelProviderParams = z.infer<typeof BridgeChannelProviderParams>;

/** A code as the person types it: eight digits. */
export const BridgeCode = z.string().regex(new RegExp(`^[0-9]{${BRIDGE_CODE_DIGITS}}$`), `${BRIDGE_CODE_DIGITS} digits`);

// Admin: the accounts -----------------------------------------------------------------------------------------------------------------------------------

export const ListBridgeAccountsResponse = z.object({ accounts: z.array(BridgeAccount).max(4) });
export type ListBridgeAccountsResponse = z.infer<typeof ListBridgeAccountsResponse>;
export const listBridgeAccountsRoute = { method: 'GET', path: '/api/admin/bridges' } as const satisfies ApiRoute;

/** Make the workspace's account for a service, or rename it. It starts `off`. */
export const PutBridgeAccountRequest = z.strictObject({
  displayName: z.string().trim().min(1).max(120),
  handle: z.string().trim().min(1).max(200).nullable().optional(),
  externalAppId: z.string().trim().min(1).max(200).nullable().optional(),
});
export type PutBridgeAccountRequest = z.infer<typeof PutBridgeAccountRequest>;
export const BridgeAccountResponse = z.object({ account: BridgeAccount });
export type BridgeAccountResponse = z.infer<typeof BridgeAccountResponse>;
export const putBridgeAccountRoute = { method: 'PUT', path: '/api/admin/bridges/:provider' } as const satisfies ApiRoute;

/** Put credentials in (sealed; shown never again). Send only what the service needs; a missing field keeps the stored one. */
export const PutBridgeCredentialsRequest = z
  .strictObject({
    botToken: z.string().min(8).max(2000).optional(),
    appSecret: z.string().min(8).max(2000).optional(),
    signingSecret: z.string().min(8).max(2000).optional(),
    inboundSecret: z.string().min(8).max(2000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one credential' });
export type PutBridgeCredentialsRequest = z.infer<typeof PutBridgeCredentialsRequest>;
export const putBridgeCredentialsRoute = { method: 'PUT', path: '/api/admin/bridges/:provider/credentials' } as const satisfies ApiRoute;

/** Turn the account on (the service is told where to send events) or off. Answers the account with `lastError` filled when the service refused. */
export const SwitchBridgeRequest = z.strictObject({ on: z.boolean() });
export type SwitchBridgeRequest = z.infer<typeof SwitchBridgeRequest>;
export const switchBridgeRoute = { method: 'POST', path: '/api/admin/bridges/:provider/switch' } as const satisfies ApiRoute;

export const DeleteBridgeAccountResponse = z.object({ removed: z.literal(true) });
export type DeleteBridgeAccountResponse = z.infer<typeof DeleteBridgeAccountResponse>;
export const deleteBridgeAccountRoute = { method: 'DELETE', path: '/api/admin/bridges/:provider' } as const satisfies ApiRoute;

// A person: link their chat user -------------------------------------------------------------------------------------------------------------------------

export const ListMyBridgesResponse = z.object({ available: z.array(BridgeAvailable), identities: z.array(BridgeIdentity) });
export type ListMyBridgesResponse = z.infer<typeof ListMyBridgesResponse>;
export const listMyBridgesRoute = { method: 'GET', path: '/api/me/bridges' } as const satisfies ApiRoute;

/** The code is shown once. `deepLink` opens the chat app with the code filled in where the service supports it (Telegram), else null. */
export const LinkCodeResponse = z.object({
  code: BridgeCode,
  expiresAt: IsoDateTime,
  deepLink: z.string().max(300).nullable(),
  /** What to send, in plain words ("Send this code to @kahf_bot"). */
  instruction: z.string().max(300),
});
export type LinkCodeResponse = z.infer<typeof LinkCodeResponse>;
export const createMyBridgeLinkCodeRoute = { method: 'POST', path: '/api/me/bridges/:provider/link-code' } as const satisfies ApiRoute;

export const UnlinkMyBridgeResponse = z.object({ unlinked: z.literal(true) });
export type UnlinkMyBridgeResponse = z.infer<typeof UnlinkMyBridgeResponse>;
export const unlinkMyBridgeRoute = { method: 'DELETE', path: '/api/me/bridges/:provider' } as const satisfies ApiRoute;

// A lead: join a public channel to an outside chat -------------------------------------------------------------------------------------------------------

export const ListChannelBridgesResponse = z.object({
  links: z.array(BridgeLink),
  /** The accounts that are on, so the tab offers "Link a Telegram group". Empty: the tab says to ask an admin. */
  accounts: z.array(BridgeAvailable),
  /** The caller is a lead of the channel's team (or an admin) and the channel is public. */
  canLink: z.boolean(),
});
export type ListChannelBridgesResponse = z.infer<typeof ListChannelBridgesResponse>;
export const listChannelBridgesRoute = { method: 'GET', path: '/api/channels/:channelId/bridge-links' } as const satisfies ApiRoute;

/** The code is typed in the outside chat as `/connect <code>`. */
export const ChannelLinkCodeResponse = LinkCodeResponse.extend({ command: z.string().max(100) });
export type ChannelLinkCodeResponse = z.infer<typeof ChannelLinkCodeResponse>;
export const createChannelBridgeCodeRoute = { method: 'POST', path: '/api/channels/:channelId/bridge-links/:provider/code' } as const satisfies ApiRoute;

export const DeleteBridgeLinkResponse = z.object({ unlinked: z.literal(true) });
export type DeleteBridgeLinkResponse = z.infer<typeof DeleteBridgeLinkResponse>;
export const deleteBridgeLinkRoute = { method: 'DELETE', path: '/api/bridge-links/:linkId' } as const satisfies ApiRoute;

// The public doors -----------------------------------------------------------------------------------------------------------------------------------------

/**
 * The chat app's events. The body is the service's own JSON; its signature or secret header is the credential. An unknown or switched-off account answers the same 404; a bad
 * signature 401 with no body stored. `GET` answers WhatsApp's verification challenge (and any service's URL check that uses a GET).
 */
export const bridgeDoorRoute = { method: 'POST', path: '/hooks/bridges/:provider/:accountId' } as const satisfies ApiRoute;
export const bridgeChallengeRoute = { method: 'GET', path: '/hooks/bridges/:provider/:accountId' } as const satisfies ApiRoute;
export const BridgeDoorResponse = z.object({ ok: z.literal(true) });
export type BridgeDoorResponse = z.infer<typeof BridgeDoorResponse>;
