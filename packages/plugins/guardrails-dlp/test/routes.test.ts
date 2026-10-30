import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, personas, type World } from '../../channels/test/world.ts';

// P10-04: Settings > Workspace > Data protection against a real server and database: who may read and change the policy, what a change does, what the
// test box keeps (nothing), and that no event or row ever carries text that was matched or a pattern.
// Omar is the workspace admin; Nadia is an Engineering member (no admin right); Tariq leads Marketing.

const { omar, nadia, tariq } = personas;
vi.setConfig({ testTimeout: 120_000 });

const KEY = 'AKIAIOSFODNN7EXAMPLE';
const CANARY_PATTERN = 'CANARYPATTERN-[0-9]{4}';
let w: World;

const policy = (who: typeof omar | null) => w.call<{ detectors: { name: string; action: string; custom: boolean }[]; rules: { id: string; name: string; pattern: string; action: string; enabled: boolean }[] }>(who, 'GET', '/api/admin/guardrails/dlp');
const setDetector = (who: typeof omar, name: string, action: string) => w.call<{ detectors: { name: string; action: string; custom: boolean }[] }>(who, 'PUT', `/api/admin/guardrails/dlp/detectors/${name}`, { action });
const policyEvents = async (): Promise<Record<string, unknown>[]> =>
  (await w.system((tx) => tx.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM app.events WHERE type = 'guardrails.policy.updated' ORDER BY id`))).rows.map((r) => r.payload);

beforeAll(async () => {
  w = await createWorld();
}, 180_000);
afterAll(async () => {
  await w?.close();
});

describe('the policy: who may read and change it', () => {
  it('shows an admin every built-in detector with its default, and refuses a member, a team lead without admin rights and a stranger', async () => {
    const res = await policy(omar);
    expect(res.status).toBe(200);
    expect(res.body.detectors.map((d) => d.name)).toEqual(['private-key', 'api-key', 'bearer-token', 'credential-url', 'secret-assignment', 'card-number', 'email-address', 'phone-number', 'iban']);
    expect(res.body.detectors.find((d) => d.name === 'api-key')).toMatchObject({ action: 'preset', custom: false });
    expect(res.body.detectors.find((d) => d.name === 'email-address')).toMatchObject({ action: 'allow', custom: false });
    expect((await policy(nadia)).status).toBe(403);
    expect((await policy(tariq)).status).toBe(403);
    expect((await policy(null)).status).toBe(401);
    expect((await setDetector(nadia as never, 'api-key', 'block')).status).toBe(403);
    expect((await w.call(nadia, 'POST', '/api/admin/guardrails/dlp/rules', { name: 'x', pattern: 'abc' })).status).toBe(403);
    expect((await w.call(nadia, 'POST', '/api/admin/guardrails/dlp/test', { text: 'hello' })).status).toBe(403);
  });
});

describe('built-in detectors', () => {
  it('stores a choice, reports it, writes one event for a real change and none for a repeat, and goes back to the default when asked', async () => {
    const before = (await policyEvents()).length;
    const set = await setDetector(omar, 'api-key', 'block');
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.detectors.find((d) => d.name === 'api-key')).toMatchObject({ action: 'block', custom: true });
    await setDetector(omar, 'api-key', 'block');
    const events = await policyEvents();
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)).toMatchObject({ kind: 'dlp', change: 'detector', subject: 'api-key', teamId: null, changedBy: omar.actorId });
    const reset = await setDetector(omar, 'api-key', 'preset');
    expect(reset.body.detectors.find((d) => d.name === 'api-key')).toMatchObject({ action: 'preset', custom: false });
    expect(await policyEvents()).toHaveLength(before + 2);
    // choosing the default of a detector that has none stored is not a change
    await setDetector(omar, 'api-key', 'preset');
    expect(await policyEvents()).toHaveLength(before + 2);
  });

  it('refuses a detector that does not exist and an action that does not exist', async () => {
    expect((await setDetector(omar, 'no-such-detector', 'block')).status).toBe(400);
    expect((await setDetector(omar, 'api-key', 'explode')).status).toBe(400);
  });
});

describe('custom rules', () => {
  let ruleId = '';

  it('adds a rule, lists it, keeps names unique and refuses a pattern that cannot be run safely', async () => {
    const added = await w.call<{ rule: { id: string; name: string; pattern: string; action: string; enabled: boolean } }>(omar, 'POST', '/api/admin/guardrails/dlp/rules', { name: 'canary-code', pattern: CANARY_PATTERN, action: 'block' });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    ruleId = added.body.rule.id;
    expect(added.body.rule).toMatchObject({ name: 'canary-code', pattern: CANARY_PATTERN, action: 'block', enabled: true });
    expect((await policy(omar)).body.rules.map((r) => r.name)).toContain('canary-code');
    expect((await w.call(omar, 'POST', '/api/admin/guardrails/dlp/rules', { name: 'canary-code', pattern: 'other' })).status).toBe(409);
    for (const pattern of ['(a+)+', 'a*', '(?=x)y', '(a)\\1', '[']) {
      const refused = await w.call<{ error: { message: string } }>(omar, 'POST', '/api/admin/guardrails/dlp/rules', { name: 'bad', pattern });
      expect(refused.status, pattern).toBe(400);
    }
    expect((await w.call(omar, 'POST', '/api/admin/guardrails/dlp/rules', { name: 'Bad Name', pattern: 'abc' })).status).toBe(400);
    // a name a built-in detector or the system uses would make a rule look like it (and 'scan-limit' would hide a real one)
    for (const name of ['api-key', 'card-number', 'scan-limit', 'unnamed']) {
      expect((await w.call(omar, 'POST', '/api/admin/guardrails/dlp/rules', { name, pattern: 'abc' })).status, name).toBe(400);
    }
  });

  it('changes a rule, writes an event only for a real change, and removes it', async () => {
    const before = (await policyEvents()).length;
    const off = await w.call<{ rule: { enabled: boolean } }>(omar, 'PATCH', `/api/admin/guardrails/dlp/rules/${ruleId}`, { enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.rule.enabled).toBe(false);
    await w.call(omar, 'PATCH', `/api/admin/guardrails/dlp/rules/${ruleId}`, { enabled: false });
    expect((await policyEvents()).length).toBe(before + 1);
    expect((await w.call(omar, 'PATCH', `/api/admin/guardrails/dlp/rules/${ruleId}`, {})).status).toBe(400);
    expect((await w.call(omar, 'PATCH', `/api/admin/guardrails/dlp/rules/${ruleId}`, { pattern: '(a+)+' })).status).toBe(400);
    expect((await w.call(omar, 'PATCH', `/api/admin/guardrails/dlp/rules/00000000-0000-4000-8000-000000000000`, { enabled: true })).status).toBe(404);
    const gone = await w.call(omar, 'DELETE', `/api/admin/guardrails/dlp/rules/${ruleId}`);
    expect(gone.status).toBe(200);
    expect((await policy(omar)).body.rules.map((r) => r.name)).not.toContain('canary-code');
    expect((await w.call(omar, 'DELETE', `/api/admin/guardrails/dlp/rules/${ruleId}`)).status).toBe(404);
    expect((await policyEvents()).at(-1)).toMatchObject({ change: 'rule_removed', subject: 'canary-code' });
  });

  it('allows at most twenty rules in a workspace', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const res = await w.call<{ rule: { id: string } }>(omar, 'POST', '/api/admin/guardrails/dlp/rules', { name: `limit-${i}`, pattern: `LIM${i}-[0-9]{3}`, enabled: false });
      expect(res.status, `rule ${i}: ${JSON.stringify(res.body)}`).toBe(201);
      ids.push(res.body.rule.id);
    }
    expect((await w.call(omar, 'POST', '/api/admin/guardrails/dlp/rules', { name: 'one-too-many', pattern: 'XYZ[0-9]' })).status).toBe(409);
    for (const id of ids) await w.call(omar, 'DELETE', `/api/admin/guardrails/dlp/rules/${id}`);
  });
});

describe('the test box', () => {
  it('judges text under the saved policy, answers the redacted text and counts, and forgets the text', async () => {
    const res = await w.call<{ outcome: string; text: string; findings: { rule: string; count: number }[] }>(omar, 'POST', '/api/admin/guardrails/dlp/test', { text: `first ${KEY} and second ${KEY}` });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ outcome: 'redact', text: 'first [redacted:api-key] and second [redacted:api-key]', findings: [{ rule: 'api-key', count: 2 }] });
    expect(JSON.stringify(res.body)).not.toContain(KEY);
  });

  it('tries an unsaved pattern without saving it, and refuses one that cannot be run', async () => {
    const res = await w.call<{ outcome: string; findings: { rule: string }[] }>(omar, 'POST', '/api/admin/guardrails/dlp/test', { text: 'ref CANARYPATTERN-1234', rule: { pattern: CANARY_PATTERN, action: 'block' } });
    expect(res.body).toMatchObject({ outcome: 'block', findings: [{ rule: 'test', count: 1 }] });
    expect((await policy(omar)).body.rules).toEqual([]);
    expect((await w.call(omar, 'POST', '/api/admin/guardrails/dlp/test', { text: 'x', rule: { pattern: '(a+)+' } })).status).toBe(400);
  });

  it('uses a stored choice: with the key set to block, the key is blocked and the text comes back unchanged', async () => {
    await setDetector(omar, 'api-key', 'block');
    const res = await w.call<{ outcome: string; text: string }>(omar, 'POST', '/api/admin/guardrails/dlp/test', { text: `deploy ${KEY}` });
    expect(res.body.outcome).toBe('block');
    await setDetector(omar, 'api-key', 'preset');
  });
});

describe('what is stored and recorded', () => {
  it('holds no matched text and no pattern in any event, and the audit console shows a change by name only', async () => {
    const events = (await w.system((tx) => tx.query<{ payload: string }>(`SELECT type || ' ' || payload::text AS payload FROM app.events WHERE type LIKE 'guardrails.%'`))).rows.map((r) => r.payload).join('\n');
    expect(events).toContain('guardrails.policy.updated');
    for (const secret of [KEY, 'CANARYPATTERN', CANARY_PATTERN]) expect(events).not.toContain(secret);
    // the live projection is asynchronous: wait for the policy changes to appear as rows
    await vi.waitFor(async () => {
      const rows = (await w.system((tx) => tx.query<{ action: string; reason: string | null; category: string }>(`SELECT action, reason, category FROM app.audit_events WHERE action = 'guard.policy_changed'`))).rows;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.category === 'guardrails')).toBe(true);
      expect(JSON.stringify(rows)).not.toMatch(/AKIA|CANARY/);
    }, { timeout: 20_000 });
  });
});

describe('each team\'s reachable hosts', () => {
  const ENG = '/api/admin/guardrails/egress';
  it('lists the teams for an admin only', async () => {
    const res = await w.call<{ teams: { teamId: string; teamName: string; enforce: boolean; hosts: string[] }[]; providerDomains: string[]; preset: string }>(omar, 'GET', ENG);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.teams.map((t) => t.teamName).sort()).toEqual(expect.arrayContaining(['Engineering', 'Marketing']));
    expect(res.body.teams.every((t) => t.enforce === false && t.hosts.length === 0)).toBe(true);
    expect(res.body.providerDomains).toContain('openai.com');
    expect((await w.call(nadia, 'GET', ENG)).status).toBe(403);
    expect((await w.call(tariq, 'GET', ENG)).status).toBe(403);
  });

  it('saves a list in its normal form, reports it, and writes one event with the team for a real change only', async () => {
    const teams = (await w.call<{ teams: { teamId: string; teamName: string }[] }>(omar, 'GET', ENG)).body.teams;
    const eng = teams.find((t) => t.teamName === 'Engineering')!.teamId;
    const before = (await policyEvents()).length;
    const body = { enforce: true, hosts: ['https://API.GitHub.com/repos', 'registry.npmjs.org', 'api.github.com'], proxyUrl: 'http://proxy.internal:3128' };
    const saved = await w.call<{ team: { enforce: boolean; hosts: string[]; proxyUrl: string | null; updatedAt: string | null } }>(omar, 'PUT', `${ENG}/${eng}`, body);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.team).toMatchObject({ enforce: true, hosts: ['api.github.com', 'registry.npmjs.org'], proxyUrl: 'http://proxy.internal:3128' });
    await w.call(omar, 'PUT', `${ENG}/${eng}`, body);
    const events = await policyEvents();
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)).toMatchObject({ kind: 'egress', change: 'team_list', subject: null, teamId: eng });
    expect(JSON.stringify(events.at(-1))).not.toMatch(/github|npmjs|proxy/);
    expect((await w.call(nadia, 'PUT', `${ENG}/${eng}`, body)).status).toBe(403);
  });

  it('refuses a model provider\'s domain on a team list, a bad host, a proxy with a password, and a team that is not in the workspace', async () => {
    const eng = (await w.call<{ teams: { teamId: string; teamName: string }[] }>(omar, 'GET', ENG)).body.teams.find((t) => t.teamName === 'Engineering')!.teamId;
    const provider = await w.call<{ error: { message: string } }>(omar, 'PUT', `${ENG}/${eng}`, { enforce: true, hosts: ['eu.api.openai.com'], proxyUrl: null });
    expect(provider.status).toBe(400);
    expect(provider.body.error.message).toContain('model provider');
    expect((await w.call(omar, 'PUT', `${ENG}/${eng}`, { enforce: true, hosts: ['not a host'], proxyUrl: null })).status).toBe(400);
    expect((await w.call(omar, 'PUT', `${ENG}/${eng}`, { enforce: true, hosts: [], proxyUrl: 'http://user:secret@proxy.internal:3128' })).status).toBe(400);
    expect((await w.call(omar, 'PUT', `${ENG}/00000000-0000-4000-8000-000000000000`, { enforce: true, hosts: [], proxyUrl: null })).status).toBe(404);
    // the refused list was not saved
    const after = (await w.call<{ teams: { teamId: string; hosts: string[] }[] }>(omar, 'GET', ENG)).body.teams.find((t) => t.teamId === eng)!;
    expect(after.hosts).toEqual(['api.github.com', 'registry.npmjs.org']);
  });
});
