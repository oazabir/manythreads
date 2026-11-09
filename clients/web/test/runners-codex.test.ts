import { beforeEach, describe, expect, it } from 'vitest';
import { setTransport, type TransportRequest } from '../src/api/client';
import { createMockTransport } from '../src/api/mock';
import { checkClaudeSignin, createBotRunner, fetchClaudeUsage, removeClaudeCredentials, uploadClaudeCredentials, uploadCodexCredentials } from '../src/screens/admin/runners/api';
import { cardsFor, needsSigninBanner, othersSentence, previewSignin, signedInWords, uploadProblem, validateNew, emptyForm } from '../src/screens/admin/runners/commands';

/*
 * The Codex sign-in on the Runners page (P19-13): the summary the browser shows before an upload (the plan and the expiry are read from the two tokens HERE, because the
 * server reads no token), the words of what blocks Upload, the exact bytes and the plan header that leave the browser, and the mock's answers (the same file rules and
 * sentences as the server). The file is made up; no real sign-in exists here.
 */

const CANARY = 'CANARY-WEB-CODEX-8e41';
const b64 = (o: unknown): string => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (payload: unknown): string => `${b64({ alg: 'none' })}.${b64(payload)}.sig-${CANARY}`;
const EXP = 1_900_000_000;

const file = (tag: string, over: { apiKey?: unknown; extra?: Record<string, unknown>; plan?: string; mode?: string } = {}): string =>
  // odd spacing and a trailing newline on purpose: the text that leaves the browser must equal the text chosen
  `${JSON.stringify(
    {
      auth_mode: over.mode ?? 'chatgpt',
      OPENAI_API_KEY: over.apiKey ?? null,
      tokens: {
        id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_plan_type: over.plan ?? 'pro' }, tag }),
        access_token: jwt({ exp: EXP, tag }),
        refresh_token: `rt-${tag}-${CANARY}`,
        account_id: `acct-${tag}`,
      },
      last_refresh: '2026-11-01T10:00:00.000Z',
      ...(over.extra ?? {}),
    },
    null,
    4,
  )}\n\n`;

describe('the summary of a chosen Codex file', () => {
  it('says the plan and the expiry read from the tokens, and never a token', () => {
    const p = previewSignin(file('a'), 'codex_cli', 1_800_000_000_000);
    expect(p).toMatchObject({ ok: true, plan: 'ChatGPT Pro plan', needsAck: false, others: { count: 0 } });
    if (p.ok) expect(p.expiresWords).toBe('The access part runs out on 2030-03-17 17:46 UTC. Codex renews it by itself.');
    expect(JSON.stringify(p)).not.toContain(CANARY);
    expect(previewSignin(file('a'), 'codex_cli', 2_000_000_000_000)).toMatchObject({ ok: true, expiresWords: expect.stringContaining('ran out on') });
    expect(previewSignin(file('a', { plan: 'plus' }), 'codex_cli')).toMatchObject({ plan: 'ChatGPT Plus plan' });
  });

  it('a file whose tokens are not readable still has a plan name, and says Codex renews by itself', () => {
    const odd = JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: 'a', access_token: 'b', refresh_token: 'c' } });
    expect(previewSignin(odd, 'codex_cli')).toMatchObject({ ok: true, plan: 'ChatGPT plan', expiresWords: 'Codex renews the access part by itself.' });
  });

  it('counts the other entries (names only) and asks for the second tick only then', () => {
    const none = previewSignin(file('c'), 'codex_cli');
    const some = previewSignin(file('c', { extra: { future_login: { token: CANARY }, other: 1 } }), 'codex_cli');
    expect(some).toMatchObject({ ok: true, needsAck: true, others: { count: 2, names: ['future_login', 'other'] } });
    expect(JSON.stringify(some)).not.toContain(CANARY);
    expect(othersSentence({ count: 2, names: ['future_login', 'other'] }, 'codex_cli')).toBe("The file also holds 2 other entries (future_login, other). They are stored with the file, as they are, in this runner's pod.");
    expect(othersSentence({ count: 1, names: ['x'] }, 'codex_cli')).toBe("The file also holds 1 other entry (x). It is stored with the file, as it is, in this runner's pod.");
    expect(othersSentence({ count: 0, names: [] }, 'codex_cli')).toBe('The file holds nothing beyond the Codex login.');
    expect(uploadProblem(null, { termsTicked: true, signinsTicked: true }, 'codex_cli')).toBe('Choose the auth.json file of a Codex login with a ChatGPT account.');
    expect(uploadProblem(none, { termsTicked: false, signinsTicked: false }, 'codex_cli')).toBe("Confirm that the ChatGPT plan's terms allow sharing this runner.");
    expect(uploadProblem(none, { termsTicked: true, signinsTicked: false }, 'codex_cli')).toBeNull();
    expect(uploadProblem(some, { termsTicked: true, signinsTicked: false }, 'codex_cli')).toMatch(/other entries/);
    expect(uploadProblem(some, { termsTicked: true, signinsTicked: true }, 'codex_cli')).toBeNull();
  });

  it('refuses a file with an API key whole, and what is not a ChatGPT login, with the server sentences and no echo', () => {
    const withKey = previewSignin(file('k', { apiKey: `sk-live-${CANARY}` }), 'codex_cli');
    expect(withKey).toMatchObject({ ok: false, message: expect.stringContaining('API key') });
    expect(JSON.stringify(withKey)).not.toContain(CANARY);
    expect(previewSignin(file('k', { mode: 'apikey' }), 'codex_cli')).toMatchObject({ ok: false, message: expect.stringContaining('ChatGPT account') });
    expect(previewSignin('not json', 'codex_cli')).toEqual({ ok: false, message: 'That is not a Codex sign-in file. Choose the auth.json from a Codex login with a ChatGPT account.' });
    // a Claude file is not a Codex file, and the other way round
    expect(previewSignin('{"claudeAiOauth":{"accessToken":"a","refreshToken":"b","expiresAt":1,"scopes":["user:inference"]}}', 'codex_cli')).toMatchObject({ ok: false });
    expect(previewSignin(file('z'), 'claude_cli')).toMatchObject({ ok: false });
  });
});

describe('the words of a signed-in Codex runner', () => {
  it('words the sign-in and the banner for both kinds', () => {
    expect(signedInWords({ kind: 'codex_cli', planLabel: 'ChatGPT Pro plan', credentialsExpiresAt: null, uploadedAt: '2026-11-06T10:00:00.000Z' })).toBe('Signed in: ChatGPT Pro plan. Uploaded 2026-11-06.');
    expect(signedInWords({ kind: 'codex_cli', planLabel: null, credentialsExpiresAt: null, uploadedAt: '2026-11-06T10:00:00.000Z' })).toBe('Signed in: ChatGPT plan. Uploaded 2026-11-06.');
    expect(signedInWords({ kind: 'codex_cli', planLabel: null, credentialsExpiresAt: null, uploadedAt: null })).toBeNull();
    expect(needsSigninBanner({ kind: 'codex_cli', status: 'needs_sign_in' })).toBe(true);
    expect(needsSigninBanner({ kind: 'claude_cli', status: 'needs_sign_in' })).toBe(true);
    expect(needsSigninBanner({ kind: 'hermes_gateway', status: 'needs_sign_in' })).toBe(false);
  });

  it('the chooser opens the Codex card with the Claude one, and the add form allows runs at once for it', () => {
    expect(cardsFor(true).filter((c) => c.available).map((c) => c.kind)).toEqual(['hermes_gateway', 'hermes_pod', 'claude_cli', 'codex_cli', 'llm_gateway']);
    expect(cardsFor(false).find((c) => c.kind === 'codex_cli')).toMatchObject({ available: false, unavailable: 'Not turned on in this install.' });
    const ok = validateNew('codex_cli', { ...emptyForm(), label: 'Codex', name: 'codex-a', maxConcurrent: 3, teams: { mode: 'all' } });
    expect(ok).toMatchObject({ ok: true, body: { kind: 'codex_cli', maxConcurrent: 3 } });
  });
});

describe('the upload call', () => {
  it('sends the chosen text unchanged with both acknowledgements and the plan name, to the route the plugin mounts', async () => {
    const seen: TransportRequest[] = [];
    setTransport(async (req) => {
      seen.push(req);
      return { status: 418, body: { error: { code: 'internal', message: 'stop' } } };
    });
    const text = file('d');
    await uploadCodexCredentials('00000000-0000-7000-8000-0000000d0002', text, 'ChatGPT Pro plan').catch(() => undefined);
    const req = seen.at(-1)!;
    expect(req).toMatchObject({ method: 'PUT', url: '/api/admin/bot-runners/00000000-0000-7000-8000-0000000d0002/credentials' });
    expect(req.body).toBe(text);
    expect(req.headers).toMatchObject({ 'x-terms-ack': '1', 'x-signins-ack': '1', 'x-plan-label': 'ChatGPT Pro plan', 'content-type': 'application/json' });
    // the Claude upload sends no plan header
    await uploadClaudeCredentials('00000000-0000-7000-8000-0000000d0002', text).catch(() => undefined);
    expect(seen.at(-1)!.headers).not.toHaveProperty('x-plan-label');
  });
});

describe('the mock answers the sign-in routes for Codex like the server', () => {
  beforeEach(() => setTransport(createMockTransport({ latencyMs: 0 })));
  const codex = async (name: string) => (await createBotRunner({ name, label: name, kind: 'codex_cli', teams: { all: true } })).runner;

  it('makes a runner that waits for a sign-in, takes a file with its plan, replaces it, checks it and removes it, never echoing the file', async () => {
    const r = await codex('cx');
    expect(r).toMatchObject({ kind: 'codex_cli', status: 'waiting_for_sign_in', uploadedAt: null });
    const up = await uploadCodexCredentials(r.id, file('e'), 'ChatGPT Pro plan');
    expect(up).toMatchObject({ replaced: false, runner: { status: 'ready', planLabel: 'ChatGPT Pro plan', credentialsExpiresAt: null } });
    expect(JSON.stringify(up)).not.toContain(CANARY);
    expect((await uploadCodexCredentials(r.id, file('e'), '<script>')).runner.planLabel).toBe('ChatGPT plan');
    expect(await checkClaudeSignin(r.id)).toMatchObject({ result: 'ok', message: 'The sign-in works.' });
    expect(await fetchClaudeUsage()).toMatchObject({ items: [{ runnerId: r.id, runs: 4 }] });
    expect((await removeClaudeCredentials(r.id)).runner).toMatchObject({ status: 'waiting_for_sign_in', uploadedAt: null, planLabel: null });
    await expect(checkClaudeSignin(r.id)).rejects.toMatchObject({ status: 409 });
  });

  it('refuses an API key file, a Claude file, and the same login on a second runner, with the server sentences', async () => {
    const a = await codex('one');
    const b = await codex('two');
    const key = await uploadCodexCredentials(a.id, file('k', { apiKey: `sk-${CANARY}` }), 'ChatGPT plan').catch((e: unknown) => e);
    expect(key).toMatchObject({ status: 400, message: expect.stringContaining('API key') });
    expect(JSON.stringify(key)).not.toContain(CANARY);
    await expect(uploadCodexCredentials(a.id, 'nonsense', 'ChatGPT plan')).rejects.toMatchObject({ status: 400, message: expect.stringContaining('not a Codex sign-in file') });
    await uploadCodexCredentials(a.id, file('same'), 'ChatGPT plan');
    await expect(uploadCodexCredentials(b.id, file('same'), 'ChatGPT plan')).rejects.toMatchObject({ status: 409, message: expect.stringContaining('every Codex runner needs its own sign-in file') });
    // a new login of the same ChatGPT account is still the same login
    await expect(uploadCodexCredentials(b.id, file('same').replace(`rt-same-${CANARY}`, 'rt-newer'), 'ChatGPT plan')).rejects.toMatchObject({ status: 409 });
    await uploadCodexCredentials(b.id, file('other'), 'ChatGPT plan');
  });
});
