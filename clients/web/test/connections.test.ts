import { beforeEach, describe, expect, it } from 'vitest';
import { CONNECTION_ADMIN_ONLY, CONNECTION_KINDS, type Connection } from '@manythreads/shared';
import { setTransport, type TransportRequest } from '../src/api/client';
import { createMockTransport } from '../src/api/mock';
import {
  createConnection,
  deleteConnection,
  fetchMyConnections,
  fetchTeamConnections,
  putConnectionCredential,
  updateConnection,
} from '../src/screens/connections/api';
import { botConnectionStanding, checkNew, credentialLine, expiryDate, expiryIso, kindLabel, stateLook, suggestSlug } from '../src/screens/connections/words';

/*
 * What the Connections pages send and say. The first part checks each call reaches the route the connections plugin mounts (written out, not derived from the
 * route objects the client uses). The second runs the same calls against the mock transport the screens use offline: its answers must parse with the shared
 * schemas, never hold a credential, and refuse what the server refuses. The third reads the plain words.
 */

const ID = '00000000-0000-7000-8000-0000000d0001';

describe('the connection calls reach the routes the plugin mounts', () => {
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
  const cases: Array<{ name: string; run: () => Promise<unknown>; method: string; url: string; body?: unknown }> = [
    { name: 'lists a team’s', run: () => fetchTeamConnections('engineering'), method: 'GET', url: '/api/teams/engineering/connections' },
    { name: 'lists mine', run: fetchMyConnections, method: 'GET', url: '/api/me/connections' },
    {
      name: 'adds one',
      run: () => createConnection('engineering', { kind: 'email', name: 'Support mailbox', environment: 'staging' }),
      method: 'POST',
      url: '/api/teams/engineering/connections',
      body: { kind: 'email', name: 'Support mailbox', environment: 'staging' },
    },
    { name: 'switches one on', run: () => updateConnection(ID, { status: 'enabled' }), method: 'PATCH', url: `/api/connections/${ID}`, body: { status: 'enabled' } },
    { name: 'puts a credential in', run: () => putConnectionCredential(ID, 'password', 'a-password'), method: 'PUT', url: `/api/connections/${ID}/credentials/password`, body: { value: 'a-password' } },
    { name: 'removes one', run: () => deleteConnection(ID), method: 'DELETE', url: `/api/connections/${ID}` },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const req = await send(c.run);
      expect(req.method).toBe(c.method);
      expect(req.url.split('?')[0]).toBe(c.url);
      if (c.body !== undefined) expect(JSON.parse(req.body ?? 'null')).toEqual(c.body);
    });
  }

  it('refuses a body the schema does not know before it leaves the browser', async () => {
    await expect(createConnection('engineering', { kind: 'email', name: 'x', password: 'secret' } as never)).rejects.toThrow();
    await expect(putConnectionCredential(ID, 'password', '')).rejects.toThrow();
    await expect(updateConnection(ID, { kind: 'github' } as never)).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });
});

describe('the mock answers as the plugin does', () => {
  const as = (who: string) => setTransport(createMockTransport({ latencyMs: 0, as: who }));

  it('a team member reads the list: Engineering has one mailbox that is on, and no answer carries a credential', async () => {
    as('nadia');
    const { connections } = await fetchTeamConnections('engineering');
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({ slug: 'support-mail', kind: 'email', status: 'enabled', hasCredentials: true, scope: 'team' });
    expect(JSON.stringify(connections)).not.toMatch(/password|secret|token/i);
    expect((await fetchMyConnections()).connections).toEqual([]);
  });

  it('only a workspace admin adds, changes, switches or removes, and anyone else is told who can', async () => {
    as('nadia');
    await expect(createConnection('engineering', { kind: 'email', name: 'Another' })).rejects.toThrow(CONNECTION_ADMIN_ONLY);
    const id = (await fetchTeamConnections('engineering')).connections[0]!.id;
    await expect(updateConnection(id, { status: 'disabled' })).rejects.toThrow(CONNECTION_ADMIN_ONLY);
    await expect(putConnectionCredential(id, 'password', 'x')).rejects.toThrow(CONNECTION_ADMIN_ONLY);
    await expect(deleteConnection(id)).rejects.toThrow(CONNECTION_ADMIN_ONLY);
  });

  it('adding goes in three steps: made off with nothing stored, the credential, then on', async () => {
    as('omar');
    const made = (await createConnection('engineering', { kind: 'email', name: 'Sales Mailbox', environment: 'staging' })).connection;
    expect(made).toMatchObject({ slug: 'sales-mailbox', status: 'disabled', hasCredentials: false, environment: 'staging' });
    await expect(updateConnection(made.id, { status: 'enabled' })).rejects.toThrow(/credential/);
    expect((await putConnectionCredential(made.id, 'password', 'mailbox-password-SENTINEL')).connection.hasCredentials).toBe(true);
    expect((await updateConnection(made.id, { status: 'enabled' })).connection.status).toBe('enabled');
    const listed = JSON.stringify(await fetchTeamConnections('engineering'));
    expect(listed).toContain('sales-mailbox');
    expect(listed).not.toContain('SENTINEL');
    expect((await createConnection('engineering', { kind: 'email', name: 'Sales Mailbox' })).connection.slug).toBe('sales-mailbox-2');
  });

  it('refuses a taken short name, and a kind that is unknown, each with words', async () => {
    as('omar');
    await expect(createConnection('engineering', { kind: 'email', name: 'Again', slug: 'support-mail' })).rejects.toThrow(/short name/);
    await expect(createConnection('engineering', { kind: 'telepathy', name: 'Mind' })).rejects.toThrow(/does not exist/);
    await expect(putConnectionCredential((await fetchTeamConnections('engineering')).connections[0]!.id, 'nothing', 'x')).rejects.toThrow(/no credential called/);
  });

  it('removing takes the row away; a second removal says there is none', async () => {
    as('omar');
    const made = (await createConnection('customer-support', { kind: 'email', name: 'Doomed' })).connection;
    expect((await deleteConnection(made.id)).deleted).toBe(true);
    await expect(deleteConnection(made.id)).rejects.toThrow(/No such connection/);
  });

  it('a person who is not in the team is refused the list', async () => {
    as('lena');
    await expect(fetchTeamConnections('engineering')).rejects.toThrow();
  });
});

describe('the words', () => {
  const conn = (patch: Partial<Connection>): Connection =>
    ({ id: ID, slug: 'support-mail', kind: 'email', name: 'Support mailbox', scope: 'team', status: 'enabled', environment: 'production', expiresAt: null, expired: false, hasCredentials: true, ...patch }) as Connection;

  it('names a connection’s state in one word, expired first and a missing credential before on or off', () => {
    expect(stateLook(conn({})).label).toBe('On');
    expect(stateLook(conn({ status: 'disabled' })).label).toBe('Off');
    expect(stateLook(conn({ hasCredentials: false, status: 'disabled' })).label).toBe('Needs a credential');
    expect(stateLook(conn({ expired: true })).label).toBe('Expired');
    expect(stateLook(conn({ expired: true })).tone).toBe('bad');
  });

  it('says only that a credential is stored, never anything about it', () => {
    expect(credentialLine({ hasCredentials: true })).toBe('A credential is stored. It cannot be shown again.');
    expect(credentialLine({ hasCredentials: false })).toBe('No credential is stored yet.');
  });

  it('makes a short name from a name', () => {
    expect(suggestSlug('Support Mailbox')).toBe('support-mailbox');
    expect(suggestSlug('  Ünï — Mail!! ')).toBe('n-mail');
    expect(suggestSlug('!!!')).toBe('');
    expect(suggestSlug('x'.repeat(100))).toHaveLength(63);
  });

  it('checks a new connection’s fields before asking', () => {
    expect(checkNew({ name: '', slug: '', credential: '' }, '').name).toMatch(/name/);
    expect(checkNew({ name: 'x'.repeat(81), slug: '', credential: '' }, '').name).toMatch(/80/);
    expect(checkNew({ name: 'ok', slug: 'Bad Slug', credential: '' }, '').slug).toMatch(/lowercase/);
    expect(checkNew({ name: 'ok', slug: 'good-slug', credential: '' }, '2026-12-01')).toEqual({});
    expect(checkNew({ name: 'ok', slug: '', credential: '' }, '12/01/2026').expires).toMatch(/date/);
  });

  it('turns a chosen day into the end of that day and back', () => {
    expect(expiryIso('')).toBeNull();
    expect(expiryIso('2026-12-01')).toBe('2026-12-01T23:59:59.000Z');
    expect(expiryIso('2026-13-45')).toBe('invalid');
    expect(expiryDate('2026-12-01T23:59:59.000Z')).toBe('2026-12-01');
    expect(expiryDate(null)).toBe('');
  });

  it('knows the Mailbox and lists the SSH and Kubernetes kinds as available', () => {
    expect(kindLabel('email')).toBe('Mailbox');
    expect(kindLabel('github')).toBe('github');
    for (const kind of ['ssh', 'kubernetes']) {
      const k = CONNECTION_KINDS.find((x) => x.kind === kind);
      expect(k?.available).toBe(true);
      expect(k?.unavailableReason).toBeUndefined();
    }
  });

  it('tells a bot’s page where each connection it names stands', () => {
    const team = [conn({}), conn({ slug: 'old-mail', name: 'Old mailbox', status: 'disabled' }), conn({ slug: 'new-mail', name: 'New mailbox', hasCredentials: false, status: 'disabled' })];
    expect(botConnectionStanding('support-mail', team)).toMatchObject({ tone: 'ok', text: expect.stringContaining('is on') });
    expect(botConnectionStanding('old-mail', team).text).toMatch(/switched off/);
    expect(botConnectionStanding('new-mail', team).text).toMatch(/no credential yet/);
    expect(botConnectionStanding('missing', team)).toMatchObject({ tone: 'warn', found: null });
    expect(botConnectionStanding('person:*', team).text).toMatch(/person who is asking/);
    expect(botConnectionStanding('support-mail', null).text).toMatch(/could not be read/);
  });
});
