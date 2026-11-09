import { describe, expect, it } from 'vitest';
import { RunSelfResponse, inspectCodexCredentials, runSelfRoute } from '../src/index.ts';
import { uuid } from './fixtures.ts';

// Bundle E WP-0: the contract of `GET /api/runs/self` (what a pod's publisher learns from a run token) and the Codex sign-in reader's stub.

describe('RunSelfResponse', () => {
  const valid = { teamSlug: 'engineering', botSlug: 'coder', runId: uuid(7), mayPublish: true };

  it('accepts a team, a bot, a run and the publish flag', () => {
    expect(RunSelfResponse.parse(valid)).toEqual(valid);
    expect(runSelfRoute).toEqual({ method: 'GET', path: '/api/runs/self' });
  });

  it('refuses a missing field and a flag that is not a boolean', () => {
    for (const key of Object.keys(valid)) expect(RunSelfResponse.safeParse({ ...valid, [key]: undefined }).success, key).toBe(false);
    expect(RunSelfResponse.safeParse({ ...valid, mayPublish: 'yes' }).success).toBe(false);
    expect(RunSelfResponse.safeParse({ ...valid, runId: 'not-a-uuid' }).success).toBe(false);
  });

  it('carries nothing else: a token in the answer does not come through', () => {
    const parsed = RunSelfResponse.parse({ ...valid, token: 'mtr_secret', address: 'http://10.0.0.5' }) as Record<string, unknown>;
    expect(parsed['token']).toBeUndefined();
    expect(parsed['address']).toBeUndefined();
  });
});

describe('inspectCodexCredentials (stub until WP-R3a)', () => {
  it('refuses every file with a short message and returns no token', () => {
    const result = inspectCodexCredentials('{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"account_id":"canary-account"}}');
    expect(result).toEqual({ ok: false, message: 'not built' });
  });
});
