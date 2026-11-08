import { defaultTrackerData, startFakeTrackers, type FakeTrackers } from '../../../../packages/test-utils/src/fake-trackers.ts';
import type { StandInModule } from './types.ts';

/** Jira, Linear, GitHub Issues and Asana on one address: the fake of packages/test-utils, wrapped. */
export const trackersModule: StandInModule = {
  id: 'trackers',
  async start(ctx) {
    const trackers: FakeTrackers = await startFakeTrackers({
      host: ctx.host,
      port: ctx.port,
      publicHost: ctx.publicHost,
      ...(ctx.clientId ? { clientId: ctx.clientId } : {}),
      ...(ctx.clientSecret ? { clientSecret: ctx.clientSecret } : {}),
    });
    return {
      id: 'trackers',
      api: trackers,
      urls: { url: trackers.url },
      env: () => trackers.env(),
      state: () => ({ calls: trackers.calls, writes: trackers.writes, searches: trackers.searches, tokenCalls: trackers.tokenCalls, consents: trackers.consents }),
      reset: () => {
        for (const list of [trackers.calls, trackers.writes, trackers.searches, trackers.graphql, trackers.tokenCalls, trackers.consents] as unknown[][]) list.length = 0;
        // the data object is read by reference by the server, so it is refilled rather than replaced
        Object.assign(trackers.data, defaultTrackerData());
      },
      stop: () => trackers.stop(),
    };
  },
};
