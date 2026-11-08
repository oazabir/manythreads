import { randomUUID } from 'node:crypto';
import { createAppPool, createPluginContext, createSecretService, createSystemPool, ExtensionRegistries, createMemoryKv, withSystem, type Tx } from '@manythreads/kernel';
import { encodeWav16kMono, makeFakeAsrWav, type LlmTranscribeRequest, type PluginEvent, type PluginTx } from '@manythreads/sdk';
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
import { assertFakeAsrAllowed, fakeAsrEnabled, TRANSCRIBE_USD_PER_MINUTE, transcribe } from '../src/transcribe.ts';

// The `transcribe` door (P15-07, decision C15) against a real database: the audio it accepts, the alias and the pre-call check, what it sends to the proxy (no proxy
// here: a recording `fetch`), the spend line, and the stand-in. The check itself (every budget and preset) is covered in preflight.test.ts; here only that the door
// asks it and obeys.

const { omar } = personas;
const ENG = TEAM_IDS.Engineering;
// the ledger is append-only, so each test uses a meeting of its own and reads only its lines
let MEETING = '';
const ACTOR = '00000000-0000-4000-8000-0000000000bb';

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
let ctx: ReturnType<typeof createPluginContext>;
let gateway: LlmProviderServices;
const emitted: PluginEvent[] = [];

const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });

/** A 1 s WAV with an audible tone (not silence), so the door sends it on. */
function tone(ms = 1000): Uint8Array {
  const samples = new Int16Array(Math.round((ms / 1000) * 16_000));
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(Math.sin(i / 8) * 8000);
  return encodeWav16kMono(samples);
}

const request = (wav: Uint8Array, over: Partial<LlmTranscribeRequest> = {}): LlmTranscribeRequest => ({
  workspaceId: omar.workspaceId,
  teamId: ENG,
  meetingId: MEETING,
  actorId: ACTOR,
  wav,
  durationMs: 1000,
  ...over,
});

interface Seen {
  url: string;
  headers: Record<string, string>;
  form: FormData;
}
/** A `fetch` that records the call and answers `answer`. */
function recordingFetch(answer: { status?: number; body: unknown }): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), headers: init?.headers as Record<string, string>, form: init?.body as FormData });
    return new Response(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body), { status: answer.status ?? 200 });
  }) as typeof fetch;
  return { fetch: f, seen };
}

const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({ MANYTHREADS_LITELLM_URL: 'http://litellm.test:4000/', MANYTHREADS_LITELLM_MASTER_KEY: 'sk-master-test', ...over });
const run = (r: LlmTranscribeRequest, deps: Parameters<typeof transcribe>[3]) => sys((tx) => transcribe(ctx, tx as unknown as PluginTx, r, deps));
const spend = () =>
  sys(async (tx) => (await tx.query<{ purpose: string; alias: string; team_id: string | null; session_id: string; cost_usd: string; model: string | null; bot_id: string | null }>(
    `SELECT purpose, alias, team_id, session_id, cost_usd::text, model, bot_id FROM app.llm_spend WHERE workspace_id = $1 AND purpose = 'transcribe' AND session_id = $2 ORDER BY occurred_at, id`,
    [omar.workspaceId, `meeting:${MEETING}`],
  )).rows);
const bind = (model = 'openai/whisper-1', providerLocal: boolean | null = null) =>
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
  appPool = createAppPool(db.appUrl, 4);
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
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

beforeEach(async () => {
  emitted.length = 0;
  MEETING = randomUUID();
  await unbind();
});

describe('the audio the door takes', () => {
  it('is on the provider the meetings plugin looks up', () => {
    expect(typeof gateway.transcribe).toBe('function');
  });
  it('refuses what is not one 16 kHz mono WAV, a WAV over 30 s, and bytes over 2 MiB, and calls nothing', async () => {
    const { fetch, seen } = recordingFetch({ body: { text: 'x' } });
    await bind();
    expect(await run(request(new TextEncoder().encode('this is not a wav file at all, but it is long enough to have a header....')), { env: env(), fetch })).toMatchObject({ outcome: 'refused' });
    const stereo = tone();
    new DataView(stereo.buffer).setUint16(22, 2, true);
    expect(await run(request(stereo), { env: env(), fetch })).toMatchObject({ outcome: 'refused', reason: 'The audio must be 16 kHz, mono, 16-bit WAV.' });
    expect(await run(request(tone(31_000)), { env: env(), fetch })).toMatchObject({ outcome: 'refused', reason: 'The audio is longer than 30 seconds.' });
    expect(await run(request(new Uint8Array(2 * 1024 * 1024 + 1)), { env: env(), fetch })).toMatchObject({ outcome: 'refused', reason: 'The audio is larger than 2 MB.' });
    expect(seen).toEqual([]);
    expect(await spend()).toEqual([]);
  });
  it('answers the empty text for silence without calling the model or recording a spend line', async () => {
    const { fetch, seen } = recordingFetch({ body: { text: 'Thank you.' } });
    await bind();
    expect(await run(request(encodeWav16kMono(new Int16Array(16_000))), { env: env(), fetch })).toEqual({ outcome: 'text', text: '', lang: null });
    expect(seen).toEqual([]);
    expect(await spend()).toEqual([]);
  });
});

describe('the alias and the proxy', () => {
  it('says so when the transcribe alias is bound to nothing, and sends nothing', async () => {
    const { fetch, seen } = recordingFetch({ body: { text: 'x' } });
    const res = await run(request(tone()), { env: env(), fetch });
    expect(res).toMatchObject({ outcome: 'unavailable' });
    expect((res as { reason: string }).reason).toContain('not bound');
    expect(seen).toEqual([]);
  });
  it('sends the WAV to /audio/transcriptions with the master key, the alias as the model and the language hint, and returns the text', async () => {
    await bind();
    const { fetch, seen } = recordingFetch({ body: { text: '  hello everyone  ', language: 'en' } });
    const res = await run(request(tone(), { lang: 'en-GB' }), { env: env(), fetch });
    expect(res).toEqual({ outcome: 'text', text: 'hello everyone', lang: 'en' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('http://litellm.test:4000/audio/transcriptions');
    expect(seen[0]!.headers).toEqual({ authorization: 'Bearer sk-master-test' });
    expect(seen[0]!.form.get('model')).toBe('transcribe');
    expect(seen[0]!.form.get('language')).toBe('en');
    const file = seen[0]!.form.get('file') as File;
    expect(file.type).toBe('audio/wav');
    expect(file.size).toBe(tone().byteLength);
  });
  it('writes one spend line per call: purpose transcribe, the team, the meeting as the session, priced by the length of the audio for a model outside the deployment', async () => {
    await bind('openai/whisper-1');
    await run(request(tone(30_000)), { env: env(), fetch: recordingFetch({ body: { text: 'a' } }).fetch });
    await run(request(tone(1000)), { env: env(), fetch: recordingFetch({ body: { text: 'b' } }).fetch });
    const rows = await spend();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ purpose: 'transcribe', alias: 'transcribe', team_id: ENG, session_id: `meeting:${MEETING}`, model: 'openai/whisper-1', bot_id: null });
    expect(Number(rows[0]!.cost_usd)).toBeCloseTo(0.5 * TRANSCRIBE_USD_PER_MINUTE, 6);
    expect(Number(rows[1]!.cost_usd)).toBeCloseTo((1 / 60) * TRANSCRIBE_USD_PER_MINUTE, 6);
  });
  it('costs nothing per call on a provider the admin marked as running inside this deployment', async () => {
    await bind('openai/Systran/faster-whisper-tiny', true);
    await run(request(tone(10_000)), { env: env(), fetch: recordingFetch({ body: { text: 'a' } }).fetch });
    expect(Number((await spend())[0]!.cost_usd)).toBe(0);
  });
  it('answers unavailable (and records no spend) for a proxy error, a busy model, a non-text answer, a missing answer and a timeout, and never echoes a key', async () => {
    await bind();
    const failed = await run(request(tone()), { env: env(), fetch: recordingFetch({ status: 500, body: '{"error":"bad key sk-abcdefghijklmnop"}' }).fetch });
    expect(failed).toMatchObject({ outcome: 'unavailable' });
    expect(JSON.stringify(failed)).not.toContain('sk-abcdefghijklmnop');
    expect(await run(request(tone()), { env: env(), fetch: recordingFetch({ status: 429, body: 'slow down' }).fetch })).toMatchObject({ outcome: 'unavailable', reason: expect.stringContaining('busy') });
    expect(await run(request(tone()), { env: env(), fetch: recordingFetch({ body: 'plain words, not json' }).fetch })).toMatchObject({ outcome: 'unavailable' });
    expect(await run(request(tone()), { env: env(), fetch: recordingFetch({ body: { nope: 1 } }).fetch })).toMatchObject({ outcome: 'unavailable' });
    const timeout = (async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    }) as unknown as typeof fetch;
    expect(await run(request(tone()), { env: env(), fetch: timeout })).toMatchObject({ outcome: 'unavailable', reason: 'The transcribe model took too long to answer.' });
    expect(await run(request(tone()), { env: { MANYTHREADS_LITELLM_URL: '' }, fetch: recordingFetch({ body: { text: 'x' } }).fetch })).toMatchObject({ outcome: 'unavailable', reason: 'No LLM gateway URL is configured.' });
    expect(await spend()).toEqual([]);
  });
});

describe('the pre-call check', () => {
  it('refuses, sends nothing and records nothing once the workspace budget is spent', async () => {
    await bind();
    await sys(async (tx) => {
      await tx.query(`INSERT INTO app.llm_limits (workspace_id, scope, limit_usd) VALUES ($1, 'workspace', 1)`, [omar.workspaceId]);
      await tx.query(`INSERT INTO app.llm_spend (workspace_id, alias, cost_usd) VALUES ($1, 'smart', 2)`, [omar.workspaceId]);
    });
    const { fetch, seen } = recordingFetch({ body: { text: 'x' } });
    const res = await run(request(tone()), { env: env(), fetch });
    expect(res.outcome).toBe('refused');
    expect(seen).toEqual([]);
    expect(await spend()).toEqual([]);
    expect(emitted.some((e) => e['type'] === 'llm.budget.exceeded')).toBe(true);
  });
  it('counts a team budget too: the spend of the team is what the check reads', async () => {
    await bind();
    await sys(async (tx) => {
      await tx.query(`INSERT INTO app.llm_limits (workspace_id, scope, team_id, limit_usd) VALUES ($1, 'team', $2, 0.001)`, [omar.workspaceId, ENG]);
      await tx.query(`INSERT INTO app.llm_spend (workspace_id, team_id, alias, cost_usd) VALUES ($1, $2, 'smart', 0.01)`, [omar.workspaceId, ENG]);
    });
    expect((await run(request(tone()), { env: env(), fetch: recordingFetch({ body: { text: 'x' } }).fetch })).outcome).toBe('refused');
    // another team is not affected
    expect((await run(request(tone(), { teamId: TEAM_IDS['Customer support'] }), { env: env(), fetch: recordingFetch({ body: { text: 'x' } }).fetch })).outcome).toBe('text');
  });
  it('under the air-gapped preset allows a model inside the deployment and refuses a hosted one', async () => {
    await sys((tx) => tx.query(`INSERT INTO app.llm_settings (workspace_id, preset) VALUES ($1, 'air-gapped')`, [omar.workspaceId]));
    await bind('openai/whisper-1');
    const hosted = recordingFetch({ body: { text: 'x' } });
    expect((await run(request(tone()), { env: env(), fetch: hosted.fetch })).outcome).toBe('refused');
    expect(hosted.seen).toEqual([]);
    await bind('openai/Systran/faster-whisper-tiny', true);
    expect(await run(request(tone()), { env: env(), fetch: recordingFetch({ body: { text: 'in the room' } }).fetch })).toMatchObject({ outcome: 'text', text: 'in the room' });
  });
});

describe('the stand-in (MANYTHREADS_FAKE_ASR=1)', () => {
  const fake = env({ MANYTHREADS_FAKE_ASR: '1' });
  it('hears the text after FAKEASR: with no proxy and no bound alias, and still records the spend line', async () => {
    expect(fakeAsrEnabled(fake)).toBe(true);
    expect(fakeAsrEnabled(env())).toBe(false);
    const res = await run(request(makeFakeAsrWav('the release is on Thursday', 2000), { lang: 'en' }), { env: { MANYTHREADS_FAKE_ASR: '1' } });
    expect(res).toEqual({ outcome: 'text', text: 'the release is on Thursday', lang: 'en' });
    const rows = await spend();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: 'fake-asr', cost_usd: '0.000000', team_id: ENG });
  });
  it('hears nothing in a WAV that has no marker', async () => {
    expect(await run(request(tone()), { env: { MANYTHREADS_FAKE_ASR: '1' } })).toMatchObject({ outcome: 'text', text: '' });
  });
  it('still obeys the pre-call check', async () => {
    await sys(async (tx) => {
      await tx.query(`INSERT INTO app.llm_limits (workspace_id, scope, limit_usd) VALUES ($1, 'workspace', 1)`, [omar.workspaceId]);
      await tx.query(`INSERT INTO app.llm_spend (workspace_id, alias, cost_usd) VALUES ($1, 'smart', 2)`, [omar.workspaceId]);
    });
    expect((await run(request(makeFakeAsrWav('hello')), { env: { MANYTHREADS_FAKE_ASR: '1' } })).outcome).toBe('refused');
  });
  it('is refused at start in production', () => {
    expect(() => assertFakeAsrAllowed({ MANYTHREADS_FAKE_ASR: '1', NODE_ENV: 'production' })).toThrow(/NODE_ENV=production/);
    expect(() => assertFakeAsrAllowed({ MANYTHREADS_FAKE_ASR: '1', NODE_ENV: 'test' })).not.toThrow();
    expect(() => assertFakeAsrAllowed({ NODE_ENV: 'production' })).not.toThrow();
    expect(() => assertFakeAsrAllowed({ MANYTHREADS_FAKE_ASR: '0', NODE_ENV: 'production' })).not.toThrow();
  });
});
