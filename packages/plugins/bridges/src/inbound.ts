import type { PluginContext } from '@manythreads/sdk';
import { abuseLimit, bridgeChallengeRoute, bridgeDoorRoute } from '@manythreads/shared';
import { notBuilt } from './not-built.ts';

// Work package B1 (P16-09, decisions D24, D26): the public door a chat service calls, `POST /hooks/bridges/:provider/:accountId` (and `GET` for a URL check). Order of work, once built:
// the account must exist and be on (one and the same 404 otherwise), the adapter verifies the signature over the RAW body (401 and nothing stored), the update id is deduped, then each message
// is read: an unlinked sender is dropped before any text is stored (a counter and at most one reply an hour), a linked sender's text is cleaned (control and bidi characters out, 4000
// characters) and posted as that person with `meta.via`, or becomes a command. STUBS: the doors answer 501 until B1 fills them in; the per-address limit and `rawBody` are the contract.
export function registerInbound(ctx: PluginContext): void {
  ctx.http.route({
    method: bridgeDoorRoute.method,
    path: bridgeDoorRoute.path,
    public: true,
    // csrf is for cookie sessions; a chat service's call carries none
    csrfExempt: true,
    rawBody: true,
    rateLimit: abuseLimit(bridgeDoorRoute.method, bridgeDoorRoute.path),
    rateLimitBy: 'address',
    handler: async () => notBuilt(),
  });
  ctx.http.route({
    method: bridgeChallengeRoute.method,
    path: bridgeChallengeRoute.path,
    public: true,
    csrfExempt: true,
    rateLimit: abuseLimit(bridgeChallengeRoute.method, bridgeChallengeRoute.path),
    rateLimitBy: 'address',
    handler: async () => notBuilt(),
  });
}
