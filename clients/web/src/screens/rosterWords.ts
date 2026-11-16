/*
 * The plain words of the Roster screen's lede (P26-18), kept apart from the component so a test can read them. Nothing here touches the network.
 */

export const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

/** The counts part of the lede only: no full stop and no tail. A team without a template definition shows the people count alone. */
export function rosterCounts(people: number, def?: { bots: readonly unknown[]; channels: readonly unknown[] } | null): string {
  const parts = [plural(people, 'person', 'people')];
  if (def) {
    parts.push(plural(def.bots.length, 'bot', 'bots'), plural(def.channels.length, 'channel', 'channels'));
  }
  return parts.join(', ');
}
