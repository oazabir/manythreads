import { beforeEach, describe, expect, it } from 'vitest';
import { setTransport, onSessionExpired } from '../src/api/client';
import * as api from '../src/api/endpoints';
import { createMockTransport, MOCK_PASSWORD } from '../src/api/mock';

const use = (opts: Parameters<typeof createMockTransport>[0] = {}) => setTransport(createMockTransport({ latencyMs: 0, ...opts }));

describe('mock transport serves schema-valid fixtures', () => {
  beforeEach(() => use());

  it('session, teams, roster, members, sign-in settings parse with the route schemas', async () => {
    const session = await api.fetchSession();
    expect(session?.workspace.name).toBe('Kahf Software');
    expect(session?.person.name).toBe('Omar Al Zabir');
    expect(await api.fetchTeams()).toHaveLength(3);
    const eng = await api.fetchTeam('engineering');
    expect(eng.template?.channels).toEqual(['#general', '#dev', '#releases', '#incidents', '#alerts', '#standup']);
    expect(eng.members.find((m) => m.role === 'lead')?.name).toBe('Omar Al Zabir');
    expect(await api.fetchMembers()).toHaveLength(7);
    const settings = await api.fetchSignInSettings();
    expect(JSON.stringify(settings)).not.toMatch(/secret"?:\s*"/i);
  });

  it('returns null session when anonymous and signs in with the mock password', async () => {
    use({ anon: true });
    expect(await api.fetchSession()).toBeNull();
    await expect(api.signInWithPassword({ email: 'nadia@kahf.co', password: 'wrong' })).rejects.toMatchObject({ status: 401, message: 'Email or password is incorrect.' });
    await expect(api.signInWithPassword({ email: 'x@other.com', password: 'whatever' })).rejects.toMatchObject({ message: 'That domain is not allowed.' });
    expect((await api.signInWithPassword({ email: 'nadia@kahf.co', password: MOCK_PASSWORD })).person.name).toBe('Nadia R.');
    expect((await api.fetchSession())?.person.email).toBe('nadia@kahf.co');
  });

  it('applies ACL like the real server will: guest 404 on workspace settings, 403 on another team', async () => {
    use({ as: 'priya' });
    await expect(api.fetchMembers()).rejects.toMatchObject({ status: 404 });
    await expect(api.fetchTeam('customer-support')).rejects.toMatchObject({ status: 403 });
    expect((await api.fetchTeam('engineering')).slug).toBe('engineering');
    use({ as: 'lena' });
    expect(await api.fetchTeams()).toEqual([]);
  });

  it('a used bootstrap link is gone (410) and a 401 raises session-expired', async () => {
    await expect(api.checkBootstrapToken('used')).rejects.toMatchObject({ status: 410 });
    use({ anon: true });
    let expired = 0;
    const off = onSessionExpired(() => expired++);
    await expect(api.fetchAccountSessions()).rejects.toMatchObject({ status: 401 });
    off();
    expect(expired).toBe(1);
  });

  it('creating the same team twice duplicates nothing', async () => {
    use({ noTeams: true });
    const a = await api.createTeam({ templateId: 'engineering', name: 'Engineering', invite: [] });
    const b = await api.createTeam({ templateId: 'engineering', name: 'Engineering', invite: [] });
    expect(b.slug).toBe(a.slug);
    expect(await api.fetchTeams()).toHaveLength(1);
  });

  it('refuses a short password on the client before any request', async () => {
    await expect(api.bootstrapWorkspace('tok', { workspaceName: 'W', name: 'N', email: 'a@b.co', password: 'short-11-ch' })).rejects.toMatchObject({ code: 'validation_failed', path: ['password'] });
  });
});
