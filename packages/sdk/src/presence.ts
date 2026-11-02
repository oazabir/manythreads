import type { PluginTx, ProviderImpl } from './types.ts';

// When a person was last seen, as other plugins see it (P14-09): `ctx.providers.get<PresenceProvider>('presence')`, registered by the presence plugin
// (`provider.presence`). The heartbeat a web tab sends every 30 seconds is the data; this is the one door to it, so a plugin that needs to know "has this
// person been away for an hour" (the notifications plugin's email digest) never reads the table. Look it up when you need it, not in `register`
// (presence may load after you).

export interface PresenceProvider extends ProviderImpl {
  id: 'presence';
  /**
   * The time of each person's latest heartbeat, for the people who have ever sent one since the heartbeat table was last emptied. A person with no
   * entry has not been seen (treat them as away). The `away` status of an open tab still counts as a heartbeat: the tab is open. Runs as the
   * transaction's actor, so the system role sees everyone and a person sees what their workspace role lets them.
   */
  lastSeen(tx: PluginTx, personIds: readonly string[]): Promise<Map<string, Date>>;
  /**
   * The people of one workspace whose latest heartbeat is newer than `since`, with its time: everyone who has been seen lately. Whoever is not in
   * the map has not been seen since `since` (or ever). It lets a job find the people who are AWAY with one list instead of asking about every
   * candidate.
   */
  seenSince(tx: PluginTx, since: Date, workspaceId: string): Promise<Map<string, Date>>;
  /**
   * When the heartbeat data started to be trustworthy: the time the first caller asked after the heartbeat table was last empty (a fresh install,
   * or a database crash, which empties it because it is UNLOGGED). Before it has been filled again for a few minutes every tab looks "away", so a
   * job that acts on absence must wait. Makes the marker on first use; system transaction only.
   */
  warmSince(tx: PluginTx): Promise<Date>;
}
