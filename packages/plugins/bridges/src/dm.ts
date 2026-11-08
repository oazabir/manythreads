import type { PluginContext } from '@manythreads/sdk';

// Work package B1 (P16-09, decision D28): a linked person's direct chat with the workspace's bot. The first private message makes a session (`bridge_dm_sessions`) tied to a direct-message
// channel with the chosen bot (the Brain by default); what the person writes is posted there as them, and the bot's answers in that channel are sent back. STUB: nothing is wired until B1
// fills it in.
export function registerDm(ctx: PluginContext): void {
  void ctx;
}
