import { route, type PluginContext } from '@manythreads/sdk';
import {
  LinkCodeResponse,
  ListMyBridgesResponse,
  UnlinkMyBridgeResponse,
  abuseLimit,
  createMyBridgeLinkCodeRoute,
  listMyBridgesRoute,
  unlinkMyBridgeRoute,
} from '@manythreads/shared';
import { notBuilt } from './not-built.ts';

// Work package B1 (P16-09, decision D25): a person's own side, Account → Chat apps. Which services are set up, which of their chat users are linked, a code to link one (five in ten minutes),
// and unlinking. STUBS: 501 until B1 fills them in.
export function registerMeRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...listMyBridgesRoute,
    schema: { response: ListMyBridgesResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...createMyBridgeLinkCodeRoute,
    schema: { response: LinkCodeResponse },
    rateLimit: abuseLimit('POST', createMyBridgeLinkCodeRoute.path),
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...unlinkMyBridgeRoute,
    schema: { response: UnlinkMyBridgeResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
}
