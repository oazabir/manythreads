import { route, type CalendarConnector, type PluginContext } from '@manythreads/sdk';
import { ListMyCalendarsResponse, listMyCalendarsRoute } from '@manythreads/shared';
import { NOT_BUILT_MESSAGE, notBuilt } from './not-built.ts';

// Work package C (P16-05, decisions D3, D4, D8, D11): the `connector.calendar` provider and the list of calendars a person can plan a room in. The provider reads the
// person's own Google or Microsoft grant (the same sealed tokens the person tools use) and nothing else. STUB: the provider answers "nothing connected" and the route 501
// until C fills them in; the interface is `CalendarConnector` in the SDK.
export function registerCalendarProvider(ctx: PluginContext): void {
  const unbuilt = { ok: false, code: 'provider_down', message: NOT_BUILT_MESSAGE } as const;
  const provider: CalendarConnector = {
    id: 'connections',
    connectedProviders: async () => [],
    calendarsOf: async () => unbuilt,
    createEvent: async () => unbuilt,
    updateEvent: async () => unbuilt,
    cancelEvent: async () => unbuilt,
    getEvent: async () => unbuilt,
    freeBusy: async () => unbuilt,
  };
  ctx.providers.register('connector.calendar', provider);

  ctx.http.route({
    ...listMyCalendarsRoute,
    schema: { response: ListMyCalendarsResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async () => notBuilt()),
  });
}
