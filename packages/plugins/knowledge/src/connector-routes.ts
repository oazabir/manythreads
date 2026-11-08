import { route, type PluginContext } from '@manythreads/sdk';
import {
  AddKnowledgeConnectorSourceRequest,
  AddKnowledgeConnectorSourceResponse,
  ListConnectorProvidersResponse,
  ListConnectorRootsQuery,
  ListConnectorRootsResponse,
  ListConnectorHealthResponse,
  addKnowledgeConnectorSourceRoute,
  addPersonalKnowledgeConnectorSourceRoute,
  connectorSourcesHealthRoute,
  listConnectorProvidersRoute,
  listConnectorRootsRoute,
} from '@manythreads/shared';
import { notBuilt } from './not-built.ts';

// Work package D2 (P16-08): adding a connector source to a team base (a lead or admin, with their own connection) or to a Personal base (its owner), the folders a person can pick, which services
// they have connected, and the admin's health rows. Removing, pausing and changing the rhythm of a source use the routes every source already has. STUBS: 501 until D2 fills them in.
export function registerConnectorRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...addKnowledgeConnectorSourceRoute,
    schema: { body: AddKnowledgeConnectorSourceRequest, response: AddKnowledgeConnectorSourceResponse },
    rateLimit: { limit: 20, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...addPersonalKnowledgeConnectorSourceRoute,
    schema: { body: AddKnowledgeConnectorSourceRequest, response: AddKnowledgeConnectorSourceResponse },
    rateLimit: { limit: 20, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...listConnectorRootsRoute,
    schema: { query: ListConnectorRootsQuery, response: ListConnectorRootsResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...listConnectorProvidersRoute,
    schema: { response: ListConnectorProvidersResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...connectorSourcesHealthRoute,
    schema: { response: ListConnectorHealthResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
}
