import { connectionKindInfo, type Connection, type ConnectionEnvironment } from '@manythreads/shared';

/*
 * The plain words and small rules of the Connections pages, kept apart from the screens so a test can read them. Nothing here touches a credential:
 * a connection only ever says that one is stored.
 */

export type StateLook = { tone: 'ok' | 'warn' | 'bad' | 'idle'; glyph: string; label: string };

/** One word for where a connection stands. A state is a word and a shape as well as a colour. */
export function stateLook(c: Pick<Connection, 'status' | 'expired' | 'hasCredentials'>): StateLook {
  if (c.expired) return { tone: 'bad', glyph: '!', label: 'Expired' };
  if (!c.hasCredentials) return { tone: 'warn', glyph: '!', label: 'Needs a credential' };
  if (c.status === 'enabled') return { tone: 'ok', glyph: '✓', label: 'On' };
  return { tone: 'idle', glyph: '–', label: 'Off' };
}

export const kindLabel = (kind: string): string => connectionKindInfo(kind)?.label ?? kind;

export const ENVIRONMENTS: ReadonlyArray<{ value: ConnectionEnvironment; label: string }> = [
  { value: 'production', label: 'Production (the real one)' },
  { value: 'staging', label: 'Staging' },
  { value: 'development', label: 'Development' },
  { value: 'test', label: 'Test' },
];

export const environmentLabel = (e: ConnectionEnvironment): string => ENVIRONMENTS.find((x) => x.value === e)?.label.split(' (')[0] ?? e;

/** What a stored credential line says. It never shows, hints at or measures the value. */
export const credentialLine = (c: Pick<Connection, 'hasCredentials'>): string => (c.hasCredentials ? 'A credential is stored. It cannot be shown again.' : 'No credential is stored yet.');

/** A short name made from what the person typed: lowercase letters, digits and dashes, at most 63 characters, never empty. */
export function suggestSlug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
  return s;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export type NewValues = { name: string; slug: string; credential: string };
export type NewErrors = Partial<Record<'name' | 'slug' | 'expires', string>>;

/** The fields the form can check before it asks; the server has the last word. */
export function checkNew(v: NewValues, expires: string): NewErrors {
  const errors: NewErrors = {};
  if (v.name.trim() === '') errors.name = 'Give the connection a name people will recognise.';
  else if (v.name.trim().length > 80) errors.name = 'Use at most 80 characters.';
  if (v.slug.trim() !== '' && !SLUG_RE.test(v.slug.trim())) errors.slug = 'Use lowercase letters, digits and dashes, starting with a letter or digit.';
  const when = expiryIso(expires);
  if (when === 'invalid') errors.expires = 'Pick a date, or leave it empty.';
  return errors;
}

/** The end of the chosen day, in UTC, as the server reads it; `null` when no date was chosen; `invalid` for something that is not a date. */
export function expiryIso(date: string): string | null | 'invalid' {
  const d = date.trim();
  if (d === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return 'invalid';
  const t = new Date(`${d}T23:59:59.000Z`);
  return Number.isNaN(t.getTime()) ? 'invalid' : t.toISOString();
}

/** The day of an expiry, for a date field. */
export const expiryDate = (iso: string | null): string => (iso === null ? '' : iso.slice(0, 10));

/** One line that tells a bot's page whether a connection named in its definition can be used right now. */
export type BotConnectionStanding = { tone: StateLook['tone']; text: string; found: Connection | null };

export function botConnectionStanding(name: string, team: readonly Connection[] | null): BotConnectionStanding {
  if (name === 'person:*') return { tone: 'idle', text: 'Uses the connections of the person who is asking, from their own account page.', found: null };
  if (team === null) return { tone: 'idle', text: 'The team’s connections could not be read just now.', found: null };
  const c = team.find((x) => x.slug === name);
  if (!c) return { tone: 'warn', text: 'The team has no connection with this name yet, so these tools are not offered.', found: null };
  const look = stateLook(c);
  const text =
    look.label === 'On'
      ? `${kindLabel(c.kind)} “${c.name}” is on. The tools below work through it.`
      : look.label === 'Expired'
        ? `${kindLabel(c.kind)} “${c.name}” has expired. The tools are not offered until its credential is renewed.`
        : look.label === 'Needs a credential'
          ? `${kindLabel(c.kind)} “${c.name}” has no credential yet, so the tools are not offered.`
          : `${kindLabel(c.kind)} “${c.name}” is switched off, so the tools are not offered.`;
  return { tone: look.tone, text, found: c };
}

export const message = (e: unknown, fallback = 'Something went wrong. Try again.'): string => (e instanceof Error && e.message !== '' ? e.message : fallback);
