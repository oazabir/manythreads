import { connectorEntry } from '@manythreads/shared';

/*
 * The plain words of the admin page for connected apps (PLAN Bundle D, P16-11). Counts, states and service names only: nothing here ever holds an account address or a token.
 */

const EXTRA: Readonly<Record<string, string>> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  slack: 'Slack',
  discord: 'Discord',
  email: 'Email',
  // the services a knowledge source reads (their ids are not catalog connectors)
  google_drive: 'Google Drive',
  onedrive: 'OneDrive',
  sharepoint: 'SharePoint',
  dropbox: 'Dropbox',
  box: 'Box',
  confluence: 'Confluence',
  notion: 'Notion',
};

/** Reasons the server gives that read badly as they are; every other reason is shown as given, with its underscores as spaces. */
const REASON_WORDS: Readonly<Record<string, string>> = { not_everyone_on_team: 'held back, not everyone on the team has access' };

/** The name people know a connector by: the catalog's, else a few chat apps, else its id with a capital. */
export function connectorName(id: string): string {
  const known = connectorEntry(id)?.label ?? EXTRA[id];
  if (known) return known;
  const spaced = id.replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A few service ids that a capital and spaces do not make into a name. */
const SERVICE_WORDS: Readonly<Record<string, string>> = {
  google_drive: 'Google Drive',
  onedrive: 'OneDrive',
  sharepoint: 'SharePoint',
  calendar_write: 'Calendar (add and change events)',
  calendar_free_busy: 'Calendar (free and busy times)',
};

/** `drive` -> `Drive`, `onedrive` -> `OneDrive`: the id with a capital and no underscores, unless it has a name of its own. */
export function serviceName(id: string): string {
  const known = SERVICE_WORDS[id];
  if (known) return known;
  const spaced = id.replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export const servicesLine = (services: readonly string[]): string => (services.length === 0 ? 'No services listed' : services.map(serviceName).join(', '));

export type PersonState = 'ok' | 'needs_reconnect' | 'disabled';
export const stateLook = (state: PersonState): { tone: 'ok' | 'warn' | 'idle'; glyph: string; label: string } =>
  state === 'ok' ? { tone: 'ok', glyph: '✓', label: 'Working' } : state === 'needs_reconnect' ? { tone: 'warn', glyph: '!', label: 'Has to sign in again' } : { tone: 'idle', glyph: '–', label: 'Switched off' };

/** "Used on 12 Oct", or "Not used yet" for a sign-in no bot has called. The server counts by day, so no time of day is shown. */
export function lastUsedLine(iso: string | null): string {
  if (!iso) return 'Not used yet';
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return 'Not used yet';
  return `Used on ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })}`;
}

export type Area = 'connections' | 'webhooks' | 'knowledge' | 'bridges';
/** What each group of rows is called, and what its numbers count. */
export const AREAS: ReadonlyArray<{ area: Area; title: string; people: string; shared: string | null; calls: string; failures: string }> = [
  { area: 'connections', title: 'Connected accounts', people: 'People connected', shared: 'Team connections', calls: 'Calls this week', failures: 'Failed' },
  { area: 'webhooks', title: 'Incoming webhooks', people: 'Endpoints', shared: null, calls: 'Deliveries this week', failures: 'Refused or failed' },
  { area: 'knowledge', title: 'Knowledge sources', people: 'Sources', shared: null, calls: 'Reads this week', failures: 'Failed' },
  { area: 'bridges', title: 'Chat apps', people: 'Accounts', shared: null, calls: 'Messages this week', failures: 'Failed' },
];

/** "3 bad signature, 1 unknown" for the reasons a webhook delivery was refused. Reasons are words from the server, shown as given. */
export function refusedLine(reasons: Readonly<Record<string, number>>): string | null {
  const parts = Object.entries(reasons)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([why, n]) => `${String(n)} ${REASON_WORDS[why] ?? why.replace(/[_-]+/g, ' ')}`);
  return parts.length === 0 ? null : parts.join(', ');
}

/** The lastUsedAt of a health row is a day at midnight UTC; show the day. */
export const lastDayLine = (iso: string | null): string => (iso ? lastUsedLine(iso).replace('Used on ', '') : 'Never');
