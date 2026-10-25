import { z } from 'zod';
import { HermesConnection, HermesConnectionAgent, HermesConnectionName } from '../../entities/hermes.ts';
import { HermesConnectionId } from '../../ids.ts';
import { TeamSlug } from '../teams/common.ts';

// The Hermes connection routes (lead or workspace admin of the team). A connection is a gateway the team's bots are placed on
// (`placement.gateway.connection` in BOT.md). Only `external` connections are made here; the team's own pod (`managed`) is registered by
// the platform. The API key is accepted on create and update and never returned.

/** A plain http(s) address of the gateway, with no credentials in it and no query. */
export const HermesBaseUrl = z
  .url({ protocol: /^https?$/ })
  .max(500)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.username === '' && u.password === '' && u.search === '' && u.hash === '';
    } catch {
      return false;
    }
  }, 'no credentials, query or fragment in the address');

export const HermesConnectionPathParams = z.object({ slug: TeamSlug });
export const HermesConnectionItemPathParams = z.object({ slug: TeamSlug, connectionId: HermesConnectionId });

export const ListHermesConnectionsResponse = z.object({ items: z.array(HermesConnection) });
export type ListHermesConnectionsResponse = z.infer<typeof ListHermesConnectionsResponse>;
export const listHermesConnectionsRoute = { method: 'GET', path: '/api/teams/:slug/hermes/connections' } as const;

export const CreateHermesConnectionRequest = z.strictObject({
  name: HermesConnectionName.refine((n) => n !== 'managed', 'the name "managed" is reserved for the team\'s own Hermes pod'),
  baseUrl: HermesBaseUrl,
  apiKey: z.string().min(8).max(500),
  /** Omitted: `hermes`. */
  agent: HermesConnectionAgent.optional(),
});
export type CreateHermesConnectionRequest = z.infer<typeof CreateHermesConnectionRequest>;
export const CreateHermesConnectionResponse = z.object({ connection: HermesConnection });
export type CreateHermesConnectionResponse = z.infer<typeof CreateHermesConnectionResponse>;
export const createHermesConnectionRoute = { method: 'POST', path: '/api/teams/:slug/hermes/connections' } as const;

export const UpdateHermesConnectionRequest = z.strictObject({
  baseUrl: HermesBaseUrl.optional(),
  apiKey: z.string().min(8).max(500).optional(),
  agent: HermesConnectionAgent.optional(),
});
export type UpdateHermesConnectionRequest = z.infer<typeof UpdateHermesConnectionRequest>;
export const UpdateHermesConnectionResponse = z.object({ connection: HermesConnection });
export type UpdateHermesConnectionResponse = z.infer<typeof UpdateHermesConnectionResponse>;
export const updateHermesConnectionRoute = { method: 'PATCH', path: '/api/teams/:slug/hermes/connections/:connectionId' } as const;

export const DeleteHermesConnectionResponse = z.object({ deleted: z.literal(true) });
export type DeleteHermesConnectionResponse = z.infer<typeof DeleteHermesConnectionResponse>;
export const deleteHermesConnectionRoute = { method: 'DELETE', path: '/api/teams/:slug/hermes/connections/:connectionId' } as const;

/** Check a connection: is the gateway reachable, does it know the profile, and which tools does that profile see? */
export const TestHermesConnectionRequest = z.strictObject({
  /** The profile to check; omitted checks the gateway's default profile. */
  profile: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(),
});
export type TestHermesConnectionRequest = z.infer<typeof TestHermesConnectionRequest>;
export const TestHermesConnectionResponse = z.object({
  ok: z.boolean(),
  /** Why the check failed, in a sentence a person can act on (never a stack or a secret). */
  error: z.string().nullable(),
  /** The gateway's API lists no MCP tools, so this is always null today; the field is kept so a later Hermes that lists them needs no new shape. */
  tools: z.array(z.string()).nullable(),
  /** Always null today (see `tools`). */
  manythreadsTools: z.boolean().nullable(),
  checkedAt: z.string(),
});
export type TestHermesConnectionResponse = z.infer<typeof TestHermesConnectionResponse>;
export const testHermesConnectionRoute = { method: 'POST', path: '/api/teams/:slug/hermes/connections/:connectionId/test' } as const;

/**
 * Turn a managed bot's profile back on after a person turned its token off (revoked or rotated it on the bot's page). The platform never mints
 * a replacement on its own: a lead or workspace admin says so here, and the bot gets a fresh token in the pod's profile set.
 */
export const ReenableHermesProfileResponse = z.object({ enabled: z.literal(true) });
export type ReenableHermesProfileResponse = z.infer<typeof ReenableHermesProfileResponse>;
export const reenableHermesProfileRoute = { method: 'POST', path: '/api/teams/:slug/bots/:botSlug/hermes/reenable' } as const;
