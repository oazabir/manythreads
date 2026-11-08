import { beforeEach, describe, expect, it } from 'vitest';
import { setTransport, type TransportRequest } from '../src/api/client';
import { createMockTransport } from '../src/api/mock';
import { disconnectPersonConnection, fetchPersonProviders, startPersonConnection } from '../src/screens/connections/personApi';
import {
  initialServices,
  isMailService,
  notSetUpSentence,
  resultFromQuery,
  servicesToTick,
  standing,
  ticksFromQuery,
  withoutResult,
  writesLine,
} from '../src/screens/connections/personWords';

/*
 * The connected-accounts page (`/settings/connections`, P8-02). The first part checks each call reaches the route the connections plugin mounts (written out,
 * not derived from the route objects the client uses). The second runs the calls against the mock the page uses offline. The third reads the plain words the
 * page says about where a provider stands and about the way back from a provider.
 */

describe('the connected-accounts calls reach the routes the plugin mounts', () => {
  let seen: TransportRequest[] = [];
  beforeEach(() => {
    seen = [];
    setTransport(async (req) => {
      seen.push(req);
      return { status: 418, body: { error: { code: 'internal', message: 'stop' } } };
    });
  });
  const send = async (run: () => Promise<unknown>): Promise<TransportRequest> => {
    await run().catch(() => undefined);
    const req = seen.at(-1);
    if (!req) throw new Error('no request was sent');
    return req;
  };

  it('lists the providers', async () => {
    const req = await send(() => fetchPersonProviders());
    expect(req.method).toBe('GET');
    expect(req.url).toBe('/api/me/connections/providers');
  });

  it('starts a connection, with the services ticked', async () => {
    const req = await send(() => startPersonConnection('google', { services: ['drive'] }));
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/me/connections/google/start');
    expect(JSON.parse(req.body ?? 'null')).toEqual({ services: ['drive'] });
  });

  it('starts with no services to ask for the provider’s usual read-only set', async () => {
    const req = await send(() => startPersonConnection('notion'));
    expect(req.url).toBe('/api/me/connections/notion/start');
    expect(JSON.parse(req.body ?? '{}')).toEqual({});
  });

  it('disconnects', async () => {
    const req = await send(() => disconnectPersonConnection('microsoft'));
    expect(req.method).toBe('DELETE');
    expect(req.url).toBe('/api/me/connections/microsoft');
  });
});

describe('the mock answers as the server does', () => {
  beforeEach(() => setTransport(createMockTransport({ latencyMs: 0, as: 'omar' })));

  it('lists Google (set up), Microsoft (not set up) and Notion (connected), without any token', async () => {
    const { providers } = await fetchPersonProviders();
    expect(providers.map((p) => [p.id, p.configured, p.connected])).toEqual([
      ['google', true, false],
      ['microsoft', false, false],
      ['notion', true, true],
    ]);
    const notion = providers.find((p) => p.id === 'notion');
    expect(notion).toMatchObject({ state: 'ok', accountLabel: 'Kahf Software' });
    expect(JSON.stringify(providers)).not.toMatch(/token|secret/i);
  });

  it('a provider that is not set up refuses Connect with the “not set up” sentence', async () => {
    await expect(startPersonConnection('microsoft')).rejects.toThrow(/not set up on this server/);
    const microsoft = (await fetchPersonProviders()).providers.find((p) => p.id === 'microsoft');
    expect(microsoft?.connected).toBe(false);
  });

  it('Connect returns the way back to this page, and the provider then reads as connected with what was ticked', async () => {
    const { url } = await startPersonConnection('google', { services: ['drive', 'calendar'] });
    expect(url).toBe('/settings/connections?connected=google');
    const google = (await fetchPersonProviders()).providers.find((p) => p.id === 'google');
    expect(google).toMatchObject({ connected: true, state: 'ok' });
    expect(google?.accountLabel).toBeTruthy();
    expect(google?.services.filter((s) => s.granted).map((s) => s.id).sort()).toEqual(['calendar', 'drive']);
  });

  it('a provider the server does not list is answered with not found', async () => {
    await expect(startPersonConnection('dropbox' as never)).rejects.toThrow(/No such provider/);
  });

  it('a service the provider does not have is refused', async () => {
    await expect(startPersonConnection('google', { services: ['nope'] })).rejects.toThrow(/no service called/);
  });

  it('Disconnect clears the account and the services, and says whether anything was connected', async () => {
    expect(await disconnectPersonConnection('notion')).toEqual({ disconnected: true });
    const notion = (await fetchPersonProviders()).providers.find((p) => p.id === 'notion');
    expect(notion).toMatchObject({ connected: false, state: null, accountLabel: null });
    expect(notion?.services.some((s) => s.granted)).toBe(false);
    expect(await disconnectPersonConnection('notion')).toEqual({ disconnected: false });
  });
});

describe('the words', () => {
  const provider = (patch: Record<string, unknown>) => ({ configured: true, connected: false, state: null, ...patch }) as Parameters<typeof standing>[0];
  const service = (id: string, writes = false, granted = false) => ({ id, label: id, description: '', tools: [], writes, granted });

  it('gives each state one word, with a shape as well as a tone', () => {
    expect(standing(provider({ configured: false }))).toMatchObject({ label: 'Not set up on this server', tone: 'idle' });
    expect(standing(provider({}))).toMatchObject({ label: 'Not connected', tone: 'idle' });
    expect(standing(provider({ connected: true, state: 'ok' }))).toMatchObject({ label: 'Connected', tone: 'ok', glyph: '✓' });
    expect(standing(provider({ connected: true, state: 'needs_reconnect' }))).toMatchObject({ label: 'Needs reconnecting', tone: 'warn', glyph: '!' });
  });

  it('tells a person who can fix a provider that is not set up', () => {
    expect(notSetUpSentence('Microsoft')).toMatch(/Microsoft is not set up on this server yet.*workspace admin/);
  });

  it('ticks only what reads and is not mail to begin with, and what was agreed to once there is something agreed', () => {
    const services = [service('drive'), service('gmail'), service('gmail_drafts', true), service('calendar'), service('calendar_write', true)];
    expect(initialServices({ services })).toEqual(['drive', 'calendar']);
    expect(initialServices({ services: [service('drive'), service('gmail', false, true)] })).toEqual(['gmail']);
    expect(isMailService({ id: 'mail_drafts' })).toBe(true);
    expect(isMailService({ id: 'onedrive' })).toBe(false);
    expect(writesLine({ writes: true })).toMatch(/waits for your approval/);
    expect(writesLine({ writes: false })).toBe('Reads only.');
  });

  it('ticks a service a link asks for (the Schedule a room dialog), only on the provider it is for and only if that provider has it', () => {
    const google = { id: 'google', services: [service('drive'), service('calendar'), service('calendar_write', true)] } as Parameters<typeof servicesToTick>[0];
    const notion = { id: 'notion', services: [service('pages')] } as Parameters<typeof servicesToTick>[0];
    const asked = ticksFromQuery('?tick=calendar_write&only=google');
    expect(asked).toEqual({ services: ['calendar_write'], only: 'google' });
    expect(servicesToTick(google, asked)).toEqual(['drive', 'calendar', 'calendar_write']);
    expect(servicesToTick(notion, asked)).toEqual(['pages']);
    // without `only` every provider that has the service ticks it; an id the provider lacks, or a junk value, is ignored
    expect(servicesToTick(google, ticksFromQuery('?tick=calendar_write'))).toEqual(['drive', 'calendar', 'calendar_write']);
    expect(servicesToTick(notion, ticksFromQuery('?tick=calendar_write'))).toEqual(['pages']);
    expect(ticksFromQuery('?tick=a b,<script>&only=../x')).toEqual({ services: [], only: null });
    expect(ticksFromQuery('')).toEqual({ services: [], only: null });
    expect(withoutResult('?tick=calendar_write&only=google&connected=google&x=1')).toBe('?x=1');
  });

  it('turns ?connected=<provider> into a sentence, with the provider’s name when the list is here', () => {
    expect(resultFromQuery('?connected=google')).toEqual({ tone: 'ok', text: 'Google is connected.' });
    expect(resultFromQuery('?connected=notion', { notion: 'Notion' })).toEqual({ tone: 'ok', text: 'Notion is connected.' });
    expect(resultFromQuery('?connected=mastodon')).toEqual({ tone: 'ok', text: 'The account is connected.' });
  });

  it('turns ?connect_error=<code> into plain words for every code the server sends, and never echoes the code', () => {
    const codes = ['denied', 'expired', 'failed', 'not_configured', 'wrong_person'];
    const sentences = codes.map((c) => resultFromQuery(`?connect_error=${c}`));
    for (const s of sentences) {
      expect(s?.tone).toBe('warn');
      expect(s?.text.endsWith('.')).toBe(true);
      expect(s?.text).not.toMatch(/_/);
    }
    expect(new Set(sentences.map((s) => s?.text)).size).toBe(codes.length);
    expect(resultFromQuery('?connect_error=denied')?.text).toBe('You chose not to allow access, so nothing was connected.');
    expect(resultFromQuery('?connect_error=<script>')).toEqual({ tone: 'warn', text: 'The sign-in did not finish. Try again.' });
  });

  it('says an error before a success if both are there, and nothing when neither is', () => {
    expect(resultFromQuery('?connected=google&connect_error=expired')?.tone).toBe('warn');
    expect(resultFromQuery('')).toBeNull();
    expect(resultFromQuery('?x=1')).toBeNull();
  });

  it('takes the result out of the address and keeps the rest', () => {
    expect(withoutResult('?connected=google')).toBe('');
    expect(withoutResult('?connect_error=denied&from=mail')).toBe('?from=mail');
    expect(withoutResult('')).toBe('');
    expect(withoutResult('?from=mail')).toBe('?from=mail');
  });
});
