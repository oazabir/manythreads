import type { PluginTx } from '@manythreads/sdk';

// Work package A (P16-11, decision D31): the daily usage counter per connection (`app.connection_usage_bump`, migration 0006). The call is made by `source.ts` once per tool
// call and counts only: a day, a connection, how many calls, how many failed. Never the arguments or what a call read. STUB: does nothing until A fills it in, so the
// tool path can already call it.
export async function bumpConnectionUsage(tx: PluginTx, input: { connectionId: string; failed: boolean }): Promise<void> {
  void [tx, input];
}
