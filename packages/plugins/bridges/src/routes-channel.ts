import { route, type PluginContext } from '@manythreads/sdk';
import {
  ChannelLinkCodeResponse,
  DeleteBridgeLinkResponse,
  ListChannelBridgesResponse,
  abuseLimit,
  createChannelBridgeCodeRoute,
  deleteBridgeLinkRoute,
  listChannelBridgesRoute,
} from '@manythreads/shared';
import { notBuilt } from './not-built.ts';

// Work package B1 (P16-09, decision D26): joining a PUBLIC channel to an outside chat. A lead who is a member asks for a code, types `/connect <code>` in the outside chat (which proves they
// control it), and the link is made by `app.bridges_link_channel`. A lead or admin removes a link. STUBS: 501 until B1 fills them in.
export function registerChannelRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...listChannelBridgesRoute,
    schema: { response: ListChannelBridgesResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...createChannelBridgeCodeRoute,
    schema: { response: ChannelLinkCodeResponse },
    rateLimit: abuseLimit('POST', createChannelBridgeCodeRoute.path),
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...deleteBridgeLinkRoute,
    schema: { response: DeleteBridgeLinkResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
}
