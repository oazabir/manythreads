import { beforeEach, describe, expect, it } from 'vitest';
import { setTransport, type TransportRequest } from '../src/api/client';
import { createMockTransport } from '../src/api/mock';
import { checkClaudeSignin, createBotRunner, fetchBotRunners, fetchClaudeUsage, removeClaudeCredentials, uploadClaudeCredentials } from '../src/screens/admin/runners/api';
import { needsSigninBanner, othersSentence, previewSignin, signedInWords, uploadProblem, usageLines } from '../src/screens/admin/runners/commands';

/*
 * The Claude Code sign-in on the Runners page (P19-06): the summary the browser shows before an upload, the words of what blocks Upload, the exact bytes that leave
 * the browser, and the mock's answers (the same file rules and sentences as the server). The file is made up; no real sign-in exists here.
 */

const CANARY = 'CANARY-WEB-5d1e';
const file = (tag: string, over: { scopes?: string[]; others?: number; expiresAt?: number } = {}): string => {
  const mcp = Object.fromEntries(Array.from({ length: over.others ?? 2 }, (_, i) => [`svc${i}|x`, { accessToken: `m-${CANARY}` }]));
  // odd spacing and a trailing newline on purpose: the text that leaves the browser must equal the text chosen
  return `${JSON.stringify({ claudeAiOauth: { accessToken: `a-${tag}-${CANARY}`, refreshToken: `r-${tag}-${CANARY}`, expiresAt: over.expiresAt ?? Date.now() + 3600_000, scopes: over.scopes ?? ['user:inference'], subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' }, mcpOAuth: mcp }, null, 4)}\n\n`;
};

describe('the summary of a chosen file', () => {
  it('says the plan, the expiry and how many other sign-ins the file holds, and never a token', () => {
    const p = previewSignin(file('a'));
    expect(p).toMatchObject({ ok: true, plan: 'Max plan · 20x', needsAck: true, others: { count: 2 } });
    expect(JSON.stringify(p)).not.toContain(CANARY);
    expect(othersSentence({ count: 2, names: ['svc0', 'svc1'] })).toBe("The file also holds 2 other sign-ins (svc0, svc1). They are stored with it, as they are, in this runner's pod.");
    expect(othersSentence({ count: 0, names: [] })).toBe('The file holds no other sign-ins.');
  });

  it('refuses what is not a sign-in file, and a login without the inference permission, with the server sentences', () => {
    expect(previewSignin('not json')).toEqual({ ok: false, message: 'That is not a Claude sign-in file. Choose the .credentials.json from a Claude login.' });
    expect(previewSignin(file('b', { scopes: ['user:profile'] }))).toMatchObject({ ok: false, message: expect.stringContaining('user:inference') });
  });

  it('asks for the second tick only when the file holds other sign-ins', () => {
    const none = previewSignin(file('c', { others: 0 }));
    expect(uploadProblem(null, { termsTicked: true, signinsTicked: true })).toMatch(/Choose the \.credentials\.json/);
    expect(uploadProblem(none, { termsTicked: false, signinsTicked: false })).toMatch(/terms allow sharing/);
    expect(uploadProblem(none, { termsTicked: true, signinsTicked: false })).toBeNull();
    const some = previewSignin(file('c'));
    expect(uploadProblem(some, { termsTicked: true, signinsTicked: false })).toMatch(/other sign-ins/);
    expect(uploadProblem(some, { termsTicked: true, signinsTicked: true })).toBeNull();
  });
});

describe('the words of a signed-in runner', () => {
  it('words the sign-in, the banner and the usage per team', () => {
    expect(signedInWords({ planLabel: 'Max plan · 20x', credentialsExpiresAt: null, uploadedAt: '2026-10-06T10:00:00.000Z' })).toBe('Signed in: Max plan · 20x. Uploaded 2026-10-06.');
    expect(signedInWords({ planLabel: null, credentialsExpiresAt: null, uploadedAt: null })).toBeNull();
    expect(needsSigninBanner({ kind: 'claude_cli', status: 'needs_sign_in' })).toBe(true);
    expect(needsSigninBanner({ kind: 'hermes_pod', status: 'needs_sign_in' })).toBe(false);
    const row = (teamId: string, teamName: string, day: string, runs: number, seconds: number, cliCost: number, runnerId = 'r1') => ({ runnerId, teamId, teamName, day, runs, seconds, cliCost }) as never;
    expect(usageLines([row('t1', 'Engineering', '2026-10-05', 3, 120, 0.1), row('t1', 'Engineering', '2026-10-06', 2, 61, 0.2), row('t2', 'Design', '2026-10-06', 1, 30, 0), row('t3', 'Other', '2026-10-06', 9, 9, 1, 'r2')], 'r1')).toEqual([
      { team: 'Engineering', runs: 5, minutes: 3, cost: '0.30' },
      { team: 'Design', runs: 1, minutes: 1, cost: null },
    ]);
  });
});

describe('the upload call', () => {
  it('sends the chosen text unchanged with both acknowledgements, to the route the plugin mounts', async () => {
    const seen: TransportRequest[] = [];
    setTransport(async (req) => {
      seen.push(req);
      return { status: 418, body: { error: { code: 'internal', message: 'stop' } } };
    });
    const text = file('d');
    await uploadClaudeCredentials('00000000-0000-7000-8000-0000000d0001', text).catch(() => undefined);
    const req = seen.at(-1)!;
    expect(req).toMatchObject({ method: 'PUT', url: '/api/admin/bot-runners/00000000-0000-7000-8000-0000000d0001/credentials' });
    expect(req.body).toBe(text);
    expect(req.headers).toMatchObject({ 'x-terms-ack': '1', 'x-signins-ack': '1', 'content-type': 'application/json' });
  });
});

describe('the mock answers the sign-in routes like the server', () => {
  beforeEach(() => setTransport(createMockTransport({ latencyMs: 0 })));
  const claude = async (name: string) => (await createBotRunner({ name, label: name, kind: 'claude_cli', teams: { all: true } })).runner;

  it('makes a runner that waits for a sign-in, takes a file, replaces it, checks it and removes it, never echoing the file', async () => {
    const r = await claude('cl');
    expect(r).toMatchObject({ status: 'waiting_for_sign_in', uploadedAt: null });
    const up = await uploadClaudeCredentials(r.id, file('e'));
    expect(up).toMatchObject({ replaced: false, runner: { status: 'ready', planLabel: 'Max plan · 20x' } });
    expect(JSON.stringify(up)).not.toContain(CANARY);
    expect((await uploadClaudeCredentials(r.id, file('e'))).replaced).toBe(true);
    expect(await checkClaudeSignin(r.id)).toMatchObject({ result: 'ok', message: 'The sign-in works.' });
    expect(await fetchClaudeUsage()).toMatchObject({ items: [{ runnerId: r.id, runs: 4 }] });
    expect((await removeClaudeCredentials(r.id)).runner).toMatchObject({ status: 'waiting_for_sign_in', uploadedAt: null, planLabel: null });
    await expect(checkClaudeSignin(r.id)).rejects.toMatchObject({ status: 409 });
  });

  it('refuses a bad file and the same login on a second runner, with the server sentences', async () => {
    const a = await claude('one');
    const b = await claude('two');
    await expect(uploadClaudeCredentials(a.id, 'nonsense')).rejects.toMatchObject({ status: 400, message: expect.stringContaining('not a Claude sign-in file') });
    await uploadClaudeCredentials(a.id, file('same'));
    await expect(uploadClaudeCredentials(b.id, file('same'))).rejects.toMatchObject({ status: 409, message: expect.stringContaining('every Claude runner needs its own sign-in file') });
    const host = (await fetchBotRunners()).items.find((x) => x.kind === 'hermes_gateway')!;
    await expect(uploadClaudeCredentials(host.id, file('f'))).rejects.toMatchObject({ status: 400 });
  });
});
