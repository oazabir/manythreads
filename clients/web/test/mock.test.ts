import { beforeEach, describe, expect, it } from 'vitest';
import { OIDC_SIGN_IN_ERROR_MESSAGES } from '@manythreads/shared';
import { onSessionExpired, setTransport } from '../src/api/client';
import * as api from '../src/api/endpoints';
import { createMockTransport, MOCK_PASSWORD } from '../src/api/mock';
import { oidcErrorMessage } from '../src/screens/SignIn';

const use = (opts: Parameters<typeof createMockTransport>[0] = {}) => setTransport(createMockTransport({ latencyMs: 0, ...opts }));

async function signedIn() {
  const s = await api.fetchSession();
  if (!s.authenticated) throw new Error('expected a session');
  return s;
}

describe('mock transport serves fixtures that parse with the shared schemas', () => {
  beforeEach(() => use());

  it('session, teams, roster, tags, members and OIDC providers', async () => {
    const session = await signedIn();
    expect(session.workspace.name).toBe('Kahf Software');
    expect(session.person.name).toBe('Omar Al Zabir');
    expect((await api.fetchTeams()).teams).toHaveLength(3);
    const { team } = await api.fetchTeam('engineering');
    expect(team.template).toBe('engineering');
    expect(team.myRole).toBe('lead');
    const roster = await api.fetchRoster('engineering');
    expect(roster.members.find((m) => m.role === 'lead')?.displayName).toBe('Omar Al Zabir');
    expect(roster.members.find((m) => m.displayName === 'Rafi K.')?.tags).toEqual(['role:on-call']);
    expect((await api.fetchTeamTags('engineering')).tags.map((t) => t.name)).toContain('role:on-call');
    expect((await api.fetchWorkspaceMembers()).members).toHaveLength(7);
    const { providers } = await api.fetchOidcProviders();
    expect(providers).toHaveLength(1);
    expect(JSON.stringify(providers)).not.toMatch(/client_?secret"?:\s*"/i);
    expect(providers[0]?.hasSecret).toBe(true);
    expect((await api.fetchTemplates()).templates).toHaveLength(5);
  });

  it('anonymous session lists methods; sign-in matches the real messages and locks after 5', async () => {
    use({ anon: true, providers: ['google', 'microsoft'] });
    const anon = await api.fetchSession();
    expect(anon.authenticated).toBe(false);
    expect(anon.methods.map((m) => m.kind)).toEqual(['password', 'google', 'microsoft']);
    expect((await api.fetchOidcMethods()).methods).toHaveLength(2);
    for (let i = 0; i < 5; i++) {
      await expect(api.signInWithPassword({ email: 'nadia@kahf.co', password: 'wrong' })).rejects.toMatchObject({ status: 401, message: 'Incorrect email or password.' });
    }
    await expect(api.signInWithPassword({ email: 'nadia@kahf.co', password: MOCK_PASSWORD })).rejects.toMatchObject({ status: 429, message: expect.stringContaining('Too many failed attempts') });
    const ok = await api.signInWithPassword({ email: 'rafi@kahf.co', password: MOCK_PASSWORD });
    expect(ok.person.name).toBe('Rafi K.');
  });

  it('maps ?error= codes to the shared sentences', () => {
    expect(oidcErrorMessage('domain_not_allowed')).toBe('That domain is not allowed.');
    expect(oidcErrorMessage('domain_not_allowed')).toBe(OIDC_SIGN_IN_ERROR_MESSAGES.domain_not_allowed);
    expect(oidcErrorMessage('nonsense')).toBeNull();
    expect(oidcErrorMessage(null)).toBeNull();
  });

  it('applies ACL like the real server: non-admin 404 on workspace settings, 403 on another team', async () => {
    use({ as: 'priya' });
    await expect(api.fetchWorkspaceMembers()).rejects.toMatchObject({ status: 404 });
    await expect(api.fetchTeam('customer-support')).rejects.toMatchObject({ status: 403 });
    expect((await api.fetchTeam('engineering')).team.slug).toBe('engineering');
    expect((await api.fetchTeams()).teams.map((t) => t.slug)).toEqual(['engineering', 'marketing']);
    use({ as: 'lena' });
    expect((await api.fetchTeams()).teams).toEqual([]);
    await expect(api.fetchTeam('engineering')).rejects.toMatchObject({ status: 403 });
  });

  it('a used bootstrap link is gone (410) and a 401 raises session-expired', async () => {
    await expect(api.checkBootstrapToken('used')).rejects.toMatchObject({ status: 410, code: 'gone' });
    use({ anon: true });
    let expired = 0;
    const off = onSessionExpired(() => expired++);
    await expect(api.fetchSessions()).rejects.toMatchObject({ status: 401 });
    off();
    expect(expired).toBe(1);
  });

  it('applying a template twice duplicates nothing; invite, accept and tag flow through', async () => {
    use({ noTeams: true });
    const a = await api.applyTeamTemplate({ templateId: 'engineering', name: 'Platform', slug: 'platform' });
    const b = await api.applyTeamTemplate({ templateId: 'engineering', name: 'Platform', slug: 'platform' });
    expect([a.created, b.created]).toEqual([true, false]);
    expect((await api.fetchTeams()).teams).toHaveLength(1);
    const inv = await api.inviteToTeam('platform', 'rafi@kahf.co');
    expect(inv.token.length).toBeGreaterThanOrEqual(20);
    expect((await api.fetchInvitation(inv.token)).teamName).toBe('Platform');
    expect((await api.acceptInvitation(inv.token, {})).createdPerson).toBe(false);
    const rafi = (await api.fetchRoster('platform')).members.find((m) => m.email === 'rafi@kahf.co')!;
    await api.assignTeamTag('platform', rafi.personId, 'role:on-call');
    expect((await api.fetchRoster('platform')).members.find((m) => m.email === 'rafi@kahf.co')?.tags).toEqual(['role:on-call']);
  });

  it('refuses a short password on the client before any request, with the shared message', async () => {
    await expect(api.bootstrapWorkspace('tok', { workspaceName: 'W', name: 'N', email: 'a@b.co', password: 'short-11-ch' })).rejects.toMatchObject({
      code: 'validation_failed',
      path: ['password'],
      message: 'Password must be at least 12 characters.',
    });
  });
  it('change password: a wrong current password is a 400 (never 401), success ends the other sessions, the new one signs in', async () => {
    use({ as: 'nadia' });
    await expect(api.changePassword({ currentPassword: 'not-the-password', newPassword: 'a-brand-new-passphrase' })).rejects.toMatchObject({
      status: 400,
      message: 'Your current password is incorrect.',
    });
    await expect(api.changePassword({ currentPassword: MOCK_PASSWORD, newPassword: '12345678901' })).rejects.toMatchObject({
      code: 'validation_failed',
      path: ['newPassword'],
      message: 'Password must be at least 12 characters.',
    });
    expect((await api.fetchSessions()).sessions).toHaveLength(3);
    expect(await api.changePassword({ currentPassword: MOCK_PASSWORD, newPassword: 'a-brand-new-passphrase' })).toEqual({ ok: true, revokedSessions: 2 });
    expect((await api.fetchSessions()).sessions.map((x) => x.current)).toEqual([true]);
    await api.signOut();
    await expect(api.signInWithPassword({ email: 'nadia@kahf.co', password: MOCK_PASSWORD })).rejects.toMatchObject({ status: 401 });
    expect((await api.signInWithPassword({ email: 'nadia@kahf.co', password: 'a-brand-new-passphrase' })).person.name).toBe('Nadia R.');
  });

  it('account name edit shows in the session', async () => {
    use({ as: 'rafi' });
    expect((await api.updateAccount({ displayName: '  Rafi Khan ' })).person.name).toBe('Rafi Khan');
    const s = await signedIn();
    expect(s.person.name).toBe('Rafi Khan');
    await expect(api.updateAccount({ displayName: '   ' })).rejects.toMatchObject({ code: 'validation_failed', message: 'Enter your name.' });
  });

  it('workspace settings: admins read and change them, everyone else gets 404; the last owner cannot be demoted', async () => {
    use();
    expect((await api.fetchWorkspace()).workspace).toMatchObject({ name: 'Kahf Software', selfSignup: false, passwordForMembers: true });
    const changed = await api.updateWorkspace({ name: 'Kahf Group', selfSignup: true, passwordForMembers: false });
    expect(changed.workspace).toMatchObject({ name: 'Kahf Group', selfSignup: true, passwordForMembers: false });
    expect((await signedIn()).workspace.name).toBe('Kahf Group');
    await expect(api.updateWorkspace({})).rejects.toMatchObject({ code: 'validation_failed' });
    const omarId = (await api.fetchWorkspaceMembers()).members.find((m) => m.email === 'omar@kahf.co')!.personId;
    await expect(api.updateWorkspaceMember(omarId, { role: 'admin' })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('at least one owner') });
    use({ as: 'nadia' });
    await expect(api.fetchWorkspace()).rejects.toMatchObject({ status: 404 });
    await expect(api.updateWorkspace({ name: 'Mine' })).rejects.toMatchObject({ status: 404 });
  });
});
