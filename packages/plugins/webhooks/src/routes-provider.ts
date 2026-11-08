import { route, type PluginContext } from '@manythreads/sdk';
import {
  CreateProviderHookRequest,
  CreateProviderHookResponse,
  DeleteProviderHookResponse,
  ListProviderHooksResponse,
  PutProviderSigningSecretRequest,
  PutProviderSigningSecretResponse,
  RotateProviderHookResponse,
  UpdateProviderHookRequest,
  UpdateProviderHookResponse,
  abuseLimit,
  createProviderHookRoute,
  deleteProviderHookRoute,
  listProviderHooksRoute,
  putProviderSigningSecretRoute,
  rotateProviderHookRoute,
  updateProviderHookRoute,
} from '@manythreads/shared';
import { notBuilt } from './not-built.ts';

// Work package H (P16-10, decisions D16 to D19): a channel's lead makes an address a work app calls (GitHub, GitLab, Jira, Linear, Zendesk, Intercom, HubSpot, Asana, or a generic sender),
// changes which kinds of event it takes, gives or replaces its signing secret, rotates it, or turns it off. The secret is sealed and shown once. STUBS: 501 until H fills them in.
export function registerProviderRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...listProviderHooksRoute,
    schema: { response: ListProviderHooksResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...createProviderHookRoute,
    schema: { body: CreateProviderHookRequest, response: CreateProviderHookResponse },
    rateLimit: abuseLimit('POST', createProviderHookRoute.path),
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...updateProviderHookRoute,
    schema: { body: UpdateProviderHookRequest, response: UpdateProviderHookResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...deleteProviderHookRoute,
    schema: { response: DeleteProviderHookResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...putProviderSigningSecretRoute,
    schema: { body: PutProviderSigningSecretRequest, response: PutProviderSigningSecretResponse },
    rateLimit: abuseLimit('PUT', putProviderSigningSecretRoute.path),
    handler: route(async () => notBuilt()),
  });
  ctx.http.route({
    ...rotateProviderHookRoute,
    schema: { response: RotateProviderHookResponse },
    rateLimit: abuseLimit('POST', rotateProviderHookRoute.path),
    handler: route(async () => notBuilt()),
  });
}
