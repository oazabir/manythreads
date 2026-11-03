import { PERSON_CONNECT_ERRORS, PersonProviderId, type PersonConnectionProvider, type PersonConnectionService } from '@manythreads/shared';

/*
 * The plain words and small rules of the connected-accounts page (`/settings/connections`), kept apart from the screen so a test can read them. Nothing here
 * touches a token: a provider only ever says whether a connection works, whose account it is and which services were agreed to.
 */

export type StandingLook = { tone: 'ok' | 'warn' | 'bad' | 'idle'; glyph: string; label: string };

/** One word for where a provider stands for this person, with a shape as well as a colour. */
export function standing(p: Pick<PersonConnectionProvider, 'configured' | 'connected' | 'state'>): StandingLook {
  if (!p.configured && !p.connected) return { tone: 'idle', glyph: '–', label: 'Not set up on this server' };
  if (p.connected && p.state === 'needs_reconnect') return { tone: 'warn', glyph: '!', label: 'Needs reconnecting' };
  if (p.connected) return { tone: 'ok', glyph: '✓', label: 'Connected' };
  return { tone: 'idle', glyph: '–', label: 'Not connected' };
}

/** What a provider that is not set up tells the person: only a workspace admin can change that. */
export const notSetUpSentence = (label: string): string =>
  `${label} is not set up on this server yet. A workspace admin has to add this server’s ${label} app (its client id and secret) before anyone can connect.`;

export const reconnectSentence = (label: string): string => `${label} stopped accepting the stored sign-in, so bots cannot use it until you connect again.`;

/** The heading of the Reconnect prompt: the same words as the notice in the person's Reminders conversation. */
export const reconnectTitle = (label: string): string => `Reconnect ${label} — access expired`;

/** What the page says when the last renewal of a working sign-in failed (the provider was down, or refused for another reason). Null when all is well. */
export function problemSentence(label: string, problem: PersonConnectionProvider['problem']): string | null {
  if (problem === 'unavailable') return `${label} could not be reached the last time we tried to renew this sign-in. We will try again; nothing is needed from you unless it keeps happening.`;
  if (problem === 'rejected') return `${label} turned down the last attempt to renew this sign-in. If it keeps happening, connect again.`;
  return null;
}

/** When the sign-in was last renewed, in a few words ("today at 08:00"); empty when it never was. */
export function renewedLine(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return at.toDateString() === now.toDateString() ? `Renewed today at ${time}` : `Renewed ${at.toLocaleDateString([], { day: 'numeric', month: 'short' })}`;
}

/**
 * The mail services (reading a mailbox, saving drafts) are opt-in: they are never ticked for a person who has not asked for them, so nothing in their mailbox is
 * reachable by accident. Everything else that only reads is ticked to begin with.
 */
export const isMailService = (s: Pick<PersonConnectionService, 'id'>): boolean => /mail/.test(s.id);

/** The services ticked when the card opens: what the person already agreed to, or else every service that only reads and is not mail. */
export function initialServices(p: Pick<PersonConnectionProvider, 'services'>): string[] {
  const granted = p.services.filter((s) => s.granted).map((s) => s.id);
  if (granted.length > 0) return granted;
  return p.services.filter((s) => !s.writes && !isMailService(s)).map((s) => s.id);
}

/** What a ticked service means for what a bot may do, in one clause. */
export const writesLine = (s: Pick<PersonConnectionService, 'writes'>): string => (s.writes ? 'Changes something outside, so each use waits for your approval.' : 'Reads only.');

export type ConnectResult = { tone: 'ok' | 'warn'; text: string };

const ERROR_WORDS: Record<(typeof PERSON_CONNECT_ERRORS)[number], string> = {
  denied: 'You chose not to allow access, so nothing was connected.',
  expired: 'That sign-in took too long or was already used. Start again.',
  failed: 'The provider did not finish the sign-in. Try again, and tell a workspace admin if it keeps happening.',
  not_configured: 'That provider is not set up on this server yet. A workspace admin has to add this server’s app for it (a client id and secret) before anyone can connect.',
  wrong_person: 'That sign-in was started by someone else. Connect again from your own account.',
};

const isErrorCode = (code: string): code is (typeof PERSON_CONNECT_ERRORS)[number] => (PERSON_CONNECT_ERRORS as readonly string[]).includes(code);

const titleCase = (id: string): string => id.slice(0, 1).toUpperCase() + id.slice(1);

/**
 * What the page says about the way back from a provider (`?connected=google` or `?connect_error=denied`): plain words, never the raw code. `labels` names the
 * providers the server knows (a provider not in it is named by its id). An unknown provider or code gets a general sentence rather than an echo of the address.
 */
export function resultFromQuery(search: string, labels: Readonly<Record<string, string>> = {}): ConnectResult | null {
  const q = new URLSearchParams(search);
  const connected = q.get('connected');
  const error = q.get('connect_error');
  if (error !== null) return { tone: 'warn', text: isErrorCode(error) ? ERROR_WORDS[error] : 'The sign-in did not finish. Try again.' };
  if (connected === null) return null;
  const parsed = PersonProviderId.safeParse(connected);
  return parsed.success ? { tone: 'ok', text: `${labels[parsed.data] ?? titleCase(parsed.data)} is connected.` } : { tone: 'ok', text: 'The account is connected.' };
}

/** The address with the result removed, so a reload does not say it again. */
export function withoutResult(search: string): string {
  const q = new URLSearchParams(search);
  q.delete('connected');
  q.delete('connect_error');
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const message = (e: unknown, fallback = 'Something went wrong. Try again.'): string => (e instanceof Error && e.message !== '' ? e.message : fallback);
