import { startFakeProviders, type FakeProviders, type SeedGrantInput } from '../../../../packages/test-utils/src/fake-providers.ts';
import { defaultScopes, seedRefreshToken, seedToken } from '../tokens.ts';
import type { StandInModule } from './types.ts';

/*
 * Google, Microsoft 365 and Notion on one address: the fake of packages/test-utils (OAuth with PKCE and rotation, Drive with permissions and `changes`, OneDrive
 * `delta`, calendars with free/busy that an account may not share, Notion search and blocks), wrapped so it can bind where a stage release reaches it and hold
 * the sign-ins a seed made. Everything it knows is in that file; this module only starts it.
 */

export const workspaceModule: StandInModule = {
  id: 'workspace',
  async start(ctx) {
    const seedGrants: SeedGrantInput[] = ctx.seedGrants.map((g) => ({
      provider: g.provider,
      email: g.email,
      scopes: g.scopes ?? defaultScopes(g.provider),
      accessToken: seedToken(g.provider, ctx.seedKey, g.email),
      ...(g.provider !== 'notion' && g.refresh !== false ? { refreshToken: seedRefreshToken(g.provider, ctx.seedKey, g.email) } : {}),
    }));
    const providers: FakeProviders = await startFakeProviders({
      host: ctx.host,
      port: ctx.port,
      publicHost: ctx.publicHost,
      seedGrants,
      ...(ctx.accounts ? { accounts: ctx.accounts } : {}),
      ...(ctx.clientId ? { clientId: ctx.clientId } : {}),
      ...(ctx.clientSecret ? { clientSecret: ctx.clientSecret } : {}),
    });
    return {
      id: 'workspace',
      api: providers,
      urls: { url: providers.url },
      env: () => providers.env(),
      state: () => ({
        apiCalls: providers.apiCalls,
        tokenCalls: providers.tokenCalls,
        consents: providers.consents,
        revoked: providers.revoked,
        createdEvents: providers.createdEvents,
        createdEventDetails: providers.createdEventDetails,
        updatedEvents: providers.updatedEvents,
        deletedEvents: providers.deletedEvents,
        outlookEventUpdates: providers.outlookEventUpdates,
        scheduleRequests: providers.scheduleRequests,
        createdPages: providers.createdPages,
        drafts: providers.drafts,
        sentMails: providers.sentMails,
        outlookSent: providers.outlookSent,
      }),
      reset: () => providers.reset(),
      stop: () => providers.stop(),
    };
  },
};
