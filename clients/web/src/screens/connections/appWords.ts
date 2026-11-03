import type { OAuthAppStatus } from '@manythreads/shared';

/** Where a provider's app comes from, in a few words. */
export function appSourceLine(a: Pick<OAuthAppStatus, 'source' | 'label'>): string {
  if (a.source === 'workspace') return 'Set up for this workspace';
  if (a.source === 'server') return 'Set up in the server’s settings';
  return 'Not set up';
}

/** The first thing wrong with what an admin typed, in a sentence; null when it can be sent. The server checks again. */
export function checkApp(input: { clientId: string; clientSecret: string; tenant: string }): string | null {
  if (input.clientId.trim() === '') return 'Enter the client id.';
  if (input.clientSecret === '') return 'Enter the client secret.';
  if (input.tenant.trim() !== '' && !/^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/.test(input.tenant.trim())) return 'The directory is an id, a domain, or one of common, organizations or consumers.';
  return null;
}
