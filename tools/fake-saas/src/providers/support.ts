import { defaultSupportData, startFakeSupport, type FakeSupport } from '../../../../packages/test-utils/src/fake-support.ts';
import type { StandInModule } from './types.ts';

/** Zendesk, Intercom, HubSpot and Salesforce, one address each (four consecutive ports): the fake of packages/test-utils, wrapped. */
export const supportModule: StandInModule = {
  id: 'support',
  ports: 4,
  async start(ctx) {
    const support: FakeSupport = await startFakeSupport({
      host: ctx.host,
      port: ctx.port,
      publicHost: ctx.publicHost,
      ...(ctx.clientId ? { clientId: ctx.clientId } : {}),
      ...(ctx.clientSecret ? { clientSecret: ctx.clientSecret } : {}),
    });
    return {
      id: 'support',
      api: support,
      urls: { ...support.urls },
      env: () => support.env(),
      state: () => ({ apiCalls: support.apiCalls, writes: support.writes, tokenCalls: support.tokenCalls, consents: support.consents, soql: support.soql }),
      reset: () => {
        for (const list of [support.apiCalls, support.tokenCalls, support.consents, support.soql] as unknown[][]) list.length = 0;
        for (const list of Object.values(support.writes) as unknown[][]) list.length = 0;
        Object.assign(support.data, defaultSupportData());
      },
      stop: () => support.stop(),
    };
  },
};
