import { route, type PluginContext } from '@manythreads/sdk';
import {
  AdminDisconnectConnectionResponse,
  ListConnectionPeopleResponse,
  ListConnectorHealthResponse,
  OffboardConnectionsRequest,
  OffboardConnectionsResponse,
  OffboardPreviewResponse,
  abuseLimit,
  adminDisconnectConnectionRoute,
  connectionsHealthRoute,
  listConnectionPeopleRoute,
  offboardConnectionsRoute,
  offboardPreviewRoute,
} from '@manythreads/shared';
import { notBuilt } from './not-built.ts';

// Work package A (P16-11, decisions D31, D32): the admin's view of connected apps (health per service, who is connected, remove one person's grant) and the offboarding
// buttons. Workspace admins only; a team lead gets 403. Content-blind. STUBS: 501 until A fills them in.
export function registerAdminRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...connectionsHealthRoute,
    schema: { response: ListConnectorHealthResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...listConnectionPeopleRoute,
    schema: { response: ListConnectionPeopleResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...adminDisconnectConnectionRoute,
    schema: { response: AdminDisconnectConnectionResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...offboardPreviewRoute,
    schema: { response: OffboardPreviewResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...offboardConnectionsRoute,
    schema: { body: OffboardConnectionsRequest, response: OffboardConnectionsResponse },
    rateLimit: abuseLimit('POST', offboardConnectionsRoute.path),
    handler: route(async () => notBuilt()),
  });
}
