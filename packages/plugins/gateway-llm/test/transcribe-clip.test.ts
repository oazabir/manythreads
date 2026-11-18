import { randomUUID } from 'node:crypto';
import { createPluginContext, createSecretService, createSystemPool, ExtensionRegistries, createMemoryKv, withSystem, type Tx } from '@manythreads/kernel';
import { VOICE_CLIP_MAX_BYTES, type LlmClipRequest, type PluginEvent, type PluginTx } from '@manythreads/sdk';
import {
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  gatewayLlmMigrationSource,
  guardrailsDlpMigrationSource,
  guardrailsEgressMigrationSource,
  personas,
  TEAM_IDS,
  teamsMigrationSource,
  testKernelMigrationSource,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import guardrailsDlp from '../../guardrails-dlp/src/index.ts';
import guardrailsEgress from '../../guardrails-egress/src/index.ts';
import gatewayLlm from '../src/index.ts';
import type { LlmProviderServices } from '../src/provider.ts';
import { clipStatus, FAKE_CLIP_TEXT, transcribeClip } from '../src/transcribe-clip.ts';

// The clip door of the `llm` provider (P32-03, decision D13) against a real database: the model must be set up and inside this deployment, what goes to the
// proxy (a recording `fetch`), that no transaction is open while the proxy works, the 8 MB cap, how failures are told apart, the spend line, the stand-in.

const { omar } = personas;
const ENG = TEAM_IDS.Engineering;
const ACTOR = '00000000-0000-4000-8000-0000000000bb';
let MESSAGE = '';

let db: TestDatabase;
let sysPool: pg.Pool;
let ctx: ReturnType<typeof createPluginContext>;
let gateway: LlmProviderServices;
/** Transactions the door has open right now (between its `inTx` start and end). */
let open = 0;
const emitted: PluginEvent[] = [];

const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const inTx = <T>(fn: (tx: PluginTx) => Promise<T>): Promise<T> => {
  open++;
  return sys((tx) => fn(tx as unknown as PluginTx)).finally(() => open--);
};

const CLIP = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
const request = (over: Partial<LlmClipRequest> = {}): LlmClipRequest => ({
  workspaceId: omar.workspaceId,
  teamId: ENG,
  messageId: MESSAGE,
  actorId: ACTOR,
  clip: CLIP,
  contentType: 'audio/webm;codecs=opus',
  durationMs: 42_000,
  ...over,
});

interface Seen {
  url: string;
  headers: Record<string, string>;
  form: FormData;
  openTransactions: number;
}
function recordingFetch(answer: { status?: number; body: unknown }): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), headers: init?.headers as Record<string, string>, form: init?.body as FormData, openTransactions: open });
    return new Response(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body), { status: answer.status ?? 200 });
  }) as typeof fetch;
  return { fetch: f, seen };
}
const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({ MANYTHREADS_LITELLM_URL: 'http://litellm.test:4000/', MANYTHREADS_LITELLM_MASTER_KEY: 'sk-master-test', ...over });
const run = (r: LlmClipRequest, deps: Parameters<typeof transcribeClip>[3]) => transcribeClip(ctx, r, inTx, deps);
const spend = () =>
  sys(async (tx) => (await tx.query<{ purpose: string; alias: string; team_id: string | null; session_id: string; cost_usd: string; model: string | null; bot_id: string | null }>(
    `SELECT purpose, alias, team_id, session_id, cost_usd::text, model, bot_id FROM app.llm_spend WHERE workspace_id = $1 AND purpose = 'transcribe' AND session_id = $2 ORDER BY occurred_at, id`,
    [omar.workspaceId, `voice:${MESSAGE}`],
  )).rows);
const bind = (model: string, providerLocal: boolean | null) =>
  sys(async (tx) => {
    await tx.query(`DELETE FROM app.llm_aliases WHERE workspace_id = $1 AND alias = 'transcribe'`, [omar.workspaceId]);
    let providerId: string | null = null;
    if (providerLocal !== null) {
      await tx.query(`DELETE FROM app.llm_providers WHERE workspace_id = $1 AND lower(name) = 'asr-test'`, [omar.workspaceId]);
      providerId = (await tx.query<{ id: string }>(
        `INSERT INTO app.llm_providers (workspace_id, name, kind, api_base, local) VALUES ($1, 'asr-test', 'openai_compatible', 'http://manythreads-asr:8000/v1', $2) RETURNING id`,
        [omar.workspaceId, providerLocal],
      )).rows[0]!.id;
    }
    await tx.query(`INSERT INTO app.llm_aliases (workspace_id, alias, model, provider_id) VALUES ($1, 'transcribe', $2, $3)`, [omar.workspaceId, model, providerId]);
  });
const bindLocal = () => bind('openai/nvidia/parakeet-tdt-0.6b-v3', true);
const unbind = () =>
  sys(async (tx) => {
    await tx.query(`DELETE FROM app.llm_aliases WHERE workspace_id = $1`, [omar.workspaceId]);
    await tx.query(`DELETE FROM app.llm_providers WHERE workspace_id = $1 AND lower(name) = 'asr-test'`, [omar.workspaceId]);
    await tx.query(`DELETE FROM app.llm_settings WHERE workspace_id = $1`, [omar.workspaceId]);
    await tx.query(`DELETE FROM app.llm_limits WHERE workspace_id = $1`, [omar.workspaceId]);
  });

beforeAll(async () => {
  delete process.env['MANYTHREADS_LITELLM_URL'];
  db = await createTestDatabase({
    sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource, gatewayLlmMigrationSource, guardrailsDlpMigrationSource, guardrailsEgressMigrationSource],
  });
  await createPersonas(db);
  sysPool = createSystemPool(db.systemUrl, 2);
  const deps: Parameters<typeof createPluginContext>[1] = {
    registries: new ExtensionRegistries(),
    storage: createMemoryKv(),
    mail: { configured: true, send: () => Promise.resolve() },
    runtime: { publicUrl: 'http://localhost:3000', now: () => new Date() },
    secrets: createSecretService(),
    emit: async (_tx: unknown, event: PluginEvent) => void emitted.push(event),
  } as never;
  for (const guardrail of [guardrailsEgress, guardrailsDlp]) await guardrail.register(createPluginContext(guardrail.manifest, deps));
  ctx = createPluginContext(gatewayLlm.manifest, deps);
  await gatewayLlm.register(ctx);
  gateway = ctx.providers.get<LlmProviderServices>('llm')!;
}, 180_000);

afterAll(async () => {
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

beforeEach(async () => {
  emitted.length = 0;
  open = 0;
  MESSAGE = randomUUID();
  await unbind();
});

describe('the door is on the provider', () => {
  it('offers transcribeClip and clipStatus next to the WAV door', () => {
    expect(typeof gateway.transcribeClip).toBe('function');
    expect(typeof gateway.clipStatus).toBe('function');
    expect(typeof gateway.transcribe).toBe('function');
  });
});

describe('only a model inside this deployment', () => {
  it('says so when the transcribe model is bound to nothing, and sends nothing', async () => {
    const { fetch, seen } = recordingFetch({ body: { text: 'x' } });
    const res = await run(request(), { env: env(), fetch });
    expect(res).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('not set up') });
    expect(seen).toEqual([]);
    expect(await sys((tx) => clipStatus(tx as unknown as PluginTx, omar.workspaceId, env()))).toMatchObject({ ready: false });
  });

  it('refuses a model on a provider that is not marked as running here, and a bound alias with no provider at all, and sends no byte', async () => {
    const { fetch, seen } = recordingFetch({ body: { text: 'x' } });
    await bind('openai/whisper-1', false);
    expect(await run(request(), { env: env(), fetch })).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('inside this deployment') });
    await bind('openai/whisper-1', null);
    expect(await run(request(), { env: env(), fetch })).toMatchObject({ outcome: 'refused' });
    expect(seen).toEqual([]);
    expect(await spend()).toEqual([]);
    expect(await sys((tx) => clipStatus(tx as unknown as PluginTx, omar.workspaceId, env()))).toMatchObject({ ready: false });
  });

  it('is ready with a local model', async () => {
    await bindLocal();
    expect(await sys((tx) => clipStatus(tx as unknown as PluginTx, omar.workspaceId, env()))).toEqual({ ready: true });
  });
});

describe('what goes to the proxy', () => {
  it('the clip as recorded, to /audio/transcriptions with the master key and the alias as the model, and the words come back', async () => {
    await bindLocal();
    const { fetch, seen } = recordingFetch({ body: { text: '  hello everyone  ', language: 'en' } });
    const res = await run(request(), { env: env(), fetch });
    expect(res).toEqual({ outcome: 'text', text: 'hello everyone', lang: 'en' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('http://litellm.test:4000/audio/transcriptions');
    expect(seen[0]!.headers).toEqual({ authorization: 'Bearer sk-master-test' });
    expect(seen[0]!.form.get('model')).toBe('transcribe');
    const file = seen[0]!.form.get('file') as File;
    expect(file.type).toBe('audio/webm;codecs=opus');
    expect(file.name).toBe('clip.webm');
    expect(file.size).toBe(CLIP.byteLength);
  });

  it('holds no database transaction while the proxy works, and opens exactly two short ones around it', async () => {
    await bindLocal();
    const { fetch, seen } = recordingFetch({ body: { text: 'hello' } });
    let started = 0;
    const counting: typeof inTx = (fn) => {
      started++;
      return inTx(fn);
    };
    await transcribeClip(ctx, request(), counting, { env: env(), fetch });
    expect(seen[0]!.openTransactions).toBe(0);
    expect(started).toBe(2);
    expect(open).toBe(0);
  });

  it('writes one spend line: purpose transcribe, the team, the message as the session, cost 0', async () => {
    await bindLocal();
    await run(request(), { env: env(), fetch: recordingFetch({ body: { text: 'a' } }).fetch });
    const rows = await spend();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purpose: 'transcribe', alias: 'transcribe', team_id: ENG, session_id: `voice:${MESSAGE}`, model: 'openai/nvidia/parakeet-tdt-0.6b-v3', bot_id: null });
    expect(Number(rows[0]!.cost_usd)).toBe(0);
  });

  it('refuses an empty clip and one over 8 MB, without calling the model', async () => {
    await bindLocal();
    const { fetch, seen } = recordingFetch({ body: { text: 'x' } });
    expect(VOICE_CLIP_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(await run(request({ clip: new Uint8Array(0) }), { env: env(), fetch })).toMatchObject({ outcome: 'refused' });
    expect(await run(request({ clip: new Uint8Array(VOICE_CLIP_MAX_BYTES + 1) }), { env: env(), fetch })).toMatchObject({ outcome: 'refused', reason: 'The recording is larger than 8 MB.' });
    expect(await run(request({ clip: new Uint8Array(VOICE_CLIP_MAX_BYTES) }), { env: env(), fetch })).toMatchObject({ outcome: 'text' });
    expect(seen).toHaveLength(1);
  });
});

describe('how a failure is told apart', () => {
  it('a busy model, a server error, a timeout and an answer that is not text may pass (unavailable); no spend line, and a key is never echoed', async () => {
    await bindLocal();
    const failed = await run(request(), { env: env(), fetch: recordingFetch({ status: 500, body: '{"error":"bad key sk-abcdefghijklmnop"}' }).fetch });
    expect(failed).toMatchObject({ outcome: 'unavailable' });
    expect(JSON.stringify(failed)).not.toContain('sk-abcdefghijklmnop');
    expect(await run(request(), { env: env(), fetch: recordingFetch({ status: 429, body: 'slow down' }).fetch })).toMatchObject({ outcome: 'unavailable', reason: expect.stringContaining('busy') });
    expect(await run(request(), { env: env(), fetch: recordingFetch({ status: 503, body: 'down' }).fetch })).toMatchObject({ outcome: 'unavailable' });
    expect(await run(request(), { env: env(), fetch: recordingFetch({ body: 'plain words, not json' }).fetch })).toMatchObject({ outcome: 'unavailable' });
    expect(await run(request(), { env: env(), fetch: recordingFetch({ body: { nope: 1 } }).fetch })).toMatchObject({ outcome: 'unavailable' });
    const timeout = (async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    }) as unknown as typeof fetch;
    expect(await run(request(), { env: env(), fetch: timeout })).toMatchObject({ outcome: 'unavailable', reason: 'The speech model took too long to answer.' });
    expect(await spend()).toEqual([]);
  });

  it('a clip the model will not read (400, 413, 415, 422) and a missing gateway are refused: waiting does not help', async () => {
    await bindLocal();
    for (const status of [400, 401, 413, 415, 422]) {
      expect(await run(request(), { env: env(), fetch: recordingFetch({ status, body: 'no' }).fetch }), String(status)).toMatchObject({ outcome: 'refused' });
    }
    expect(await run(request(), { env: { MANYTHREADS_LITELLM_URL: '' }, fetch: recordingFetch({ body: { text: 'x' } }).fetch })).toMatchObject({ outcome: 'refused', reason: 'No LLM gateway URL is configured.' });
    expect(await spend()).toEqual([]);
  });
});

describe('the pre-call check', () => {
  it('refuses, sends nothing and records nothing once the workspace budget is spent', async () => {
    await bindLocal();
    await sys(async (tx) => {
      await tx.query(`INSERT INTO app.llm_limits (workspace_id, scope, limit_usd) VALUES ($1, 'workspace', 1)`, [omar.workspaceId]);
      await tx.query(`INSERT INTO app.llm_spend (workspace_id, alias, cost_usd) VALUES ($1, 'smart', 2)`, [omar.workspaceId]);
    });
    const { fetch, seen } = recordingFetch({ body: { text: 'x' } });
    expect((await run(request(), { env: env(), fetch })).outcome).toBe('refused');
    expect(seen).toEqual([]);
    expect(await spend()).toEqual([]);
  });
});

describe('the stand-in (MANYTHREADS_FAKE_ASR=1)', () => {
  const fake = env({ MANYTHREADS_FAKE_ASR: '1' });
  it('answers the fixed sentence with no proxy and no bound model, and still records the spend line', async () => {
    const { fetch, seen } = recordingFetch({ body: { text: 'never' } });
    expect(await run(request(), { env: fake, fetch, fakeDelayMs: 0 })).toEqual({ outcome: 'text', text: FAKE_CLIP_TEXT, lang: 'en' });
    expect(seen).toEqual([]);
    const rows = await spend();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: 'fake-asr', cost_usd: '0.000000', team_id: ENG });
    expect(await sys((tx) => clipStatus(tx as unknown as PluginTx, omar.workspaceId, fake))).toEqual({ ready: true });
  });
  it('still obeys the pre-call check', async () => {
    await sys(async (tx) => {
      await tx.query(`INSERT INTO app.llm_limits (workspace_id, scope, limit_usd) VALUES ($1, 'workspace', 1)`, [omar.workspaceId]);
      await tx.query(`INSERT INTO app.llm_spend (workspace_id, alias, cost_usd) VALUES ($1, 'smart', 2)`, [omar.workspaceId]);
    });
    expect((await run(request(), { env: fake, fakeDelayMs: 0 })).outcome).toBe('refused');
  });
});
