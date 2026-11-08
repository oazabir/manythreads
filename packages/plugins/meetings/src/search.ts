import type { PluginContext } from '@manythreads/sdk';
import { MEETINGS_SEARCH_CAPABILITY } from '@manythreads/shared';

// Work package S7 (P15-13): the `meetings.search` capability. It answers a bot with the lines of meetings the person it acts for may read, the same answer that person's
// own search gets; the database policies decide, never this file. STUB: answers that it is not built until S7.
export function registerSearch(ctx: PluginContext): void {
  ctx.capabilities.register(MEETINGS_SEARCH_CAPABILITY, async () => ({ ok: false, code: 'not_built', message: 'Not built yet' }));
}
