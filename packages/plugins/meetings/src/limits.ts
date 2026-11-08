import type { PluginContext } from '@manythreads/sdk';

// Work package S1 (P15-16, decision C12): the limits on a room: its size (`meeting_settings.room_cap`), a cap on lines a minute, the strip of control and bidirectional
// characters, the 2 MiB transcript size. STUB: nothing is registered until S1.
export function registerLimits(ctx: PluginContext): void {
  void ctx;
  // S1: the room-cap check used by the join route, the per-room line limiter.
}
