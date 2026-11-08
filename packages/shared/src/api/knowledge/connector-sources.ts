import { z } from 'zod';
import { KnowledgeBaseSlug, KnowledgeSource, KnowledgeSyncMinutes } from '../../entities/knowledge.ts';
import { ConnectorRoot, KnowledgeConnectorProvider } from '../../entities/connector-source.ts';
import type { ApiRoute } from '../client/route.ts';
import { TeamSlug } from '../teams/common.ts';

// Document sources that ride on a person's connection (PLAN Bundle D, P16-08, plugin `knowledge`). A person adds a folder, space, site or database from one of their OWN
// connections to their Personal base; a team lead or admin adds one to a team base from their own connection, and only documents everyone on the team can already open
// at the app are copied (anything else stays with the people who can open it). The routes read the roots with the caller's own grant and never show a token.
// docs/plugins/knowledge.md.

/** Add a connector source. `acknowledgeTeamRule` is the consent sentence of a team source: it must be true there. */
export const AddKnowledgeConnectorSourceRequest = z.strictObject({
  provider: KnowledgeConnectorProvider,
  /** The provider's id of the folder, space, site-and-drive or database (from the roots list). */
  root: z.string().min(1).max(1024),
  /** The name shown on the source; defaults to the root's name. */
  label: z.string().trim().min(1).max(120).optional(),
  syncMinutes: KnowledgeSyncMinutes.default(60),
  acknowledgeTeamRule: z.boolean().default(false),
});
export type AddKnowledgeConnectorSourceRequest = z.infer<typeof AddKnowledgeConnectorSourceRequest>;
export const AddKnowledgeConnectorSourceResponse = z.object({ source: KnowledgeSource });
export type AddKnowledgeConnectorSourceResponse = z.infer<typeof AddKnowledgeConnectorSourceResponse>;
export const addKnowledgeConnectorSourceRoute = { method: 'POST', path: '/api/teams/:slug/knowledge/:base/connector-sources' } as const satisfies ApiRoute;
export const addPersonalKnowledgeConnectorSourceRoute = { method: 'POST', path: '/api/me/knowledge/:base/connector-sources' } as const satisfies ApiRoute;
export const KnowledgeConnectorTeamParams = z.object({ slug: TeamSlug, base: KnowledgeBaseSlug });
export type KnowledgeConnectorTeamParams = z.infer<typeof KnowledgeConnectorTeamParams>;
export const KnowledgeConnectorPersonalParams = z.object({ base: KnowledgeBaseSlug });
export type KnowledgeConnectorPersonalParams = z.infer<typeof KnowledgeConnectorPersonalParams>;

/** The folders, spaces, sites or databases the caller's own connection offers for a provider (at most 200). */
export const ListConnectorRootsQuery = z.object({ provider: KnowledgeConnectorProvider, parent: z.string().min(1).max(1024).optional() });
export type ListConnectorRootsQuery = z.infer<typeof ListConnectorRootsQuery>;
export const ListConnectorRootsResponse = z.object({
  roots: z.array(ConnectorRoot).max(200),
  /** False when the caller has not connected the provider (or the needed service): the form offers to connect. */
  connected: z.boolean(),
});
export type ListConnectorRootsResponse = z.infer<typeof ListConnectorRootsResponse>;
export const listConnectorRootsRoute = { method: 'GET', path: '/api/me/knowledge-roots' } as const satisfies ApiRoute;

/** Which providers the caller has connected, so the form lists only those. */
export const ListConnectorProvidersResponse = z.object({ providers: z.array(KnowledgeConnectorProvider) });
export type ListConnectorProvidersResponse = z.infer<typeof ListConnectorProvidersResponse>;
export const listConnectorProvidersRoute = { method: 'GET', path: '/api/me/knowledge-providers' } as const satisfies ApiRoute;
