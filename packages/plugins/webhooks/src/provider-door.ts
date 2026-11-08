import type { PluginContext } from '@manythreads/sdk';
import { abuseLimit, providerHookDoorRoute } from '@manythreads/shared';
import { notBuilt } from './not-built.ts';

// Work package H (P16-10, decisions D18, D19): the public door a work app calls, `POST /hooks/apps/:endpointId`. The signature header is the credential: it is checked over the RAW body
// with the endpoint's sealed secret before anything is read, a repeat of a delivery is answered 200 `duplicate`, an unknown, revoked or switched-off endpoint answers one and the
// same 404, and a refusal is counted (never logged with a body). STUB: 501 until H fills it in; `rawBody` and the per-address limit are the contract.
export function registerProviderDoor(ctx: PluginContext): void {
  ctx.http.route({
    method: providerHookDoorRoute.method,
    path: providerHookDoorRoute.path,
    public: true,
    // csrf is for cookie sessions; a work app's call carries none
    csrfExempt: true,
    rawBody: true,
    rateLimit: abuseLimit('POST', providerHookDoorRoute.path),
    rateLimitBy: 'address',
    handler: async () => notBuilt(),
  });
}
