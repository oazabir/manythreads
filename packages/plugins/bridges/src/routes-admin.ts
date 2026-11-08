import { route, type PluginContext } from '@manythreads/sdk';
import {
  BridgeAccountResponse,
  DeleteBridgeAccountResponse,
  ListBridgeAccountsResponse,
  ListConnectorHealthResponse,
  PutBridgeAccountRequest,
  PutBridgeCredentialsRequest,
  SwitchBridgeRequest,
  abuseLimit,
  bridgesHealthRoute,
  deleteBridgeAccountRoute,
  listBridgeAccountsRoute,
  putBridgeAccountRoute,
  putBridgeCredentialsRoute,
  switchBridgeRoute,
} from '@manythreads/shared';
import { notBuilt } from './not-built.ts';

// Work package B1 (P16-09): the workspace admin's side. Make or rename the account of a service, put its credentials in (sealed, never read back), turn it on or off (on tells the service where to
// send events), remove it, and read its health. Workspace admins only. STUBS: 501 until B1 fills them in.
export function registerAdminRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...listBridgeAccountsRoute,
    schema: { response: ListBridgeAccountsResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...putBridgeAccountRoute,
    schema: { body: PutBridgeAccountRequest, response: BridgeAccountResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...putBridgeCredentialsRoute,
    schema: { body: PutBridgeCredentialsRequest, response: BridgeAccountResponse },
    rateLimit: abuseLimit('PUT', putBridgeCredentialsRoute.path),
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...switchBridgeRoute,
    schema: { body: SwitchBridgeRequest, response: BridgeAccountResponse },
    rateLimit: { limit: 20, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...deleteBridgeAccountRoute,
    schema: { response: DeleteBridgeAccountResponse },
    rateLimit: { limit: 20, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...bridgesHealthRoute,
    schema: { response: ListConnectorHealthResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
}
