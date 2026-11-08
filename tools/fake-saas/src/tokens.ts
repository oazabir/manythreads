import { createHash, randomBytes } from 'node:crypto';

/*
 * Sign-ins that exist before any consent (PLAN Bundle D, D2). A seeded stack seals the same values this module derives, so a connected Nadia needs no browser consent
 * dance: `seedToken('google', key, 'nadia@kahf.example')` is the access token the seed stores and the stand-in accepts. Nothing here is secret: the values exist only
 * where the stand-in runs, and the stand-in refuses to start in production.
 */

/** The providers whose sign-in can be seeded: the ones with an OAuth stand-in that keeps tokens in one place (workspace: Google, Microsoft, Notion). */
export type SeedProvider = 'google' | 'microsoft' | 'notion';

export interface SeedGrant {
  provider: SeedProvider;
  /** The account at the provider (an address). */
  email: string;
  /** Default: the broad set of `defaultScopes(provider)`. */
  scopes?: string[];
  /** Google and Microsoft: also hand out a refresh token (default true). Notion tokens do not expire. */
  refresh?: boolean;
}

const google = (name: string): string => `https://www.googleapis.com/auth/${name}`;

/** What a seeded grant is allowed to do by default: reading files, reading and writing events and asking free/busy; mail read for the mail tools. */
export function defaultScopes(provider: SeedProvider): string[] {
  if (provider === 'google') return ['openid', 'email', google('drive.readonly'), google('calendar.events'), google('calendar.events.readonly'), google('calendar.freebusy'), google('gmail.readonly')];
  if (provider === 'microsoft') return ['offline_access', 'Files.Read', 'Files.Read.All', 'Sites.Read.All', 'Calendars.ReadWrite', 'Calendars.Read', 'Calendars.ReadBasic', 'Mail.Read'];
  return [];
}

const digest = (...parts: string[]): string => createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 24);

/** The access token of a seeded grant: `fs_<provider>_<first 24 hex of sha256(seedKey + email)>`. */
export function seedToken(provider: SeedProvider, seedKey: string, email: string): string {
  return `fs_${provider}_${digest(seedKey, email.toLowerCase())}`;
}

/** The refresh token of a seeded grant: the same recipe with an `r` in front of the provider. */
export function seedRefreshToken(provider: SeedProvider, seedKey: string, email: string): string {
  return `fsr_${provider}_${digest(seedKey, 'refresh', email.toLowerCase())}`;
}

/** A fresh secret for a test that needs one (webhook signing secrets, link codes): URL-safe, 24 characters. */
export const randomSecret = (): string => randomBytes(18).toString('base64url');
