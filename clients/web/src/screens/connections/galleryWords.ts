import type { ConnectorEntry } from '@manythreads/shared';

/** How a connector is signed in to, in a few plain words for the card. */
export function authLine(e: Pick<ConnectorEntry, 'auth' | 'provider' | 'heldBy'>): string {
  const how = e.auth === 'oauth' ? `Sign in with ${e.provider}` : e.auth === 'app_install' ? `Install an app in ${e.provider}` : 'Paste a key or password';
  const who = e.heldBy.length === 1 && e.heldBy[0] === 'person' ? 'each person signs in for themselves' : 'a workspace admin sets it up for a team';
  return `${how}; ${who}`;
}

/** What a bot can do through it, as a count. */
export function toolsLine(n: number): string {
  if (n === 0) return 'no tools yet';
  return n === 1 ? '1 tool for bots' : `${String(n)} tools for bots`;
}
