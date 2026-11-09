import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentTraceId, setTraceBridge, traceHeaders, traceRoot, traceSpan, tracingOn } from '@manythreads/sdk';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-node';
import Fastify from 'fastify';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { registerHttpTracing } from '../src/http-trace.ts';
import { ALLOWED_ATTRIBUTES, cleanAttributes, otelConfigFromEnv, startOtel, tracesUrl, type OtelHandle } from '../src/otel.ts';

// P10-10 traces. What is proven: with no endpoint nothing is loaded and nothing is slower; with one, a request yields a server span whose children are the database
// transactions it opened, the log lines of that request carry the same trace id, and a call to our own service carries that trace's `traceparent`; and no message text,
// name or query ever rides on a span.

const here = dirname(fileURLToPath(import.meta.url));
const server = resolve(here, '..');

let handle: OtelHandle | null = null;
afterEach(async () => {
  await handle?.shutdown();
  handle = null;
  setTraceBridge(null);
});

async function tracing(sampleRatio = 1) {
  const exporter = new InMemorySpanExporter();
  handle = await startOtel({ endpoint: 'http://collector.invalid:4318', sampleRatio }, { exporter, simple: true });
  return exporter;
}

describe('configuration', () => {
  it('is off without an endpoint, and an empty one counts as unset', () => {
    expect(otelConfigFromEnv({})).toEqual({ config: null });
    expect(otelConfigFromEnv({ MANYTHREADS_OTEL_EXPORTER_OTLP_ENDPOINT: '  ' })).toEqual({ config: null });
  });
  it('reads the endpoint and a sample ratio (default 1)', () => {
    expect(otelConfigFromEnv({ MANYTHREADS_OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318' }).config).toEqual({ endpoint: 'http://otel-collector:4318', sampleRatio: 1 });
    expect(otelConfigFromEnv({ MANYTHREADS_OTEL_EXPORTER_OTLP_ENDPOINT: 'https://c.example', MANYTHREADS_OTEL_SAMPLE_RATIO: '0.25' }).config?.sampleRatio).toBe(0.25);
  });
  it('a typo turns tracing off and says why; it does not stop the server', () => {
    for (const env of [
      { MANYTHREADS_OTEL_EXPORTER_OTLP_ENDPOINT: 'collector:4318' },
      { MANYTHREADS_OTEL_EXPORTER_OTLP_ENDPOINT: 'ftp://c' },
      { MANYTHREADS_OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c', MANYTHREADS_OTEL_SAMPLE_RATIO: '2' },
      { MANYTHREADS_OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c', MANYTHREADS_OTEL_SAMPLE_RATIO: 'lots' },
    ]) {
      const r = otelConfigFromEnv(env);
      expect(r.config).toBeNull();
      expect(r.problem).toMatch(/tracing stays off/);
    }
  });
  it('posts to the OTLP traces path, once', () => {
    expect(tracesUrl('http://c:4318')).toBe('http://c:4318/v1/traces');
    expect(tracesUrl('http://c:4318/')).toBe('http://c:4318/v1/traces');
    expect(tracesUrl('http://c:4318/v1/traces')).toBe('http://c:4318/v1/traces');
  });
});

describe('off means off', () => {
  const runFixture = (mode: 'off' | 'on') => {
    const res = spawnSync(process.execPath, ['--import', 'tsx', resolve(here, 'fixtures/otel-off.ts'), mode], { cwd: server, encoding: 'utf8' });
    expect(res.status, res.stderr).toBe(0);
    return JSON.parse(res.stdout.trim().split('\n').at(-1) ?? '{}') as { handle: boolean; tracing: boolean; hooks: string[]; before: number; loaded: number };
  };

  it('with no endpoint no OpenTelemetry module is loaded, no bridge exists and no request hook is added', () => {
    const r = runFixture('off');
    expect(r).toMatchObject({ handle: false, tracing: false, hooks: [], loaded: 0 });
  });

  it('the same fixture with an endpoint does load them (so the check above can fail)', () => {
    const r = runFixture('on');
    expect(r.handle).toBe(true);
    expect(r.tracing).toBe(true);
    expect(r.loaded).toBeGreaterThan(5);
  });

  it('every call is a plain pass-through with no bridge', async () => {
    expect(tracingOn()).toBe(false);
    expect(await traceSpan('x', {}, async () => 7)).toBe(7);
    expect(await traceRoot('x', {}, async () => 8)).toBe(8);
    expect(traceHeaders()).toEqual({});
    expect(currentTraceId()).toBeUndefined();
  });
});

describe('attributes', () => {
  it('keeps ids, kinds and counts and drops everything else', () => {
    const kept = cleanAttributes({
      'http.route': '/api/channels/:id/messages',
      'mt.actor_id': '44444444-4444-4444-4444-444444444444',
      'mt.llm.messages': 3,
      'mt.db.read_only': true,
      'mt.message_text': 'the quarterly numbers are bad',
      'http.url': 'https://x/api?token=abc',
      'person.name': 'Nadia',
    });
    expect(Object.keys(kept).sort()).toEqual(['http.route', 'mt.actor_id', 'mt.db.read_only', 'mt.llm.messages']);
  });
  it('drops a value that looks like text even under an allowed name', () => {
    expect(cleanAttributes({ 'mt.llm.alias': 'what did we decide about pricing?', 'mt.job.queue': 'x'.repeat(200), 'mt.bot_id': 'a b', 'mt.run_id': undefined, 'mt.llm.messages': Number.NaN })).toEqual({});
    expect(cleanAttributes({ 'mt.llm.alias': 'smart', 'mt.job.queue': 'files.gc' })).toEqual({ 'mt.llm.alias': 'smart', 'mt.job.queue': 'files.gc' });
  });
  it('no allowed name can hold text by its name', () => {
    for (const name of ALLOWED_ATTRIBUTES) expect(name).not.toMatch(/text|body|content|(^|[._])name$|email|query|sql|url|address|secret|(^|\.)(token|key|password)$/);
  });
});

describe('a traced request', () => {
  /** A server with the tracing hooks and a route that does two "transactions" and then calls a service of ours. */
  async function app() {
    const lines: Array<Record<string, unknown>> = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, cb) {
        for (const l of chunk.toString().split('\n')) if (l.trim()) lines.push(JSON.parse(l) as Record<string, unknown>);
        cb();
      },
    });
    const f = Fastify({ logger: { stream } });
    registerHttpTracing(f);
    let sent: Record<string, string> = {};
    f.get('/api/things/:id', async (req) => {
      req.log.info('handling');
      await traceSpan('db.transaction', { 'mt.db.actor_kind': 'person' }, async () => undefined);
      await traceSpan('db.transaction', { 'mt.db.actor_kind': 'system', 'mt.db.read_only': true }, async () => {
        await traceSpan('llm.chat', { 'mt.llm.alias': 'smart', 'mt.llm.purpose': 'run' }, async () => {
          sent = traceHeaders();
        });
      });
      return { ok: true };
    });
    f.get('/healthz', async () => ({ ok: true }));
    f.get('/boom', async () => {
      throw new Error('a person wrote this secret sentence');
    });
    await f.ready();
    return { f, lines, sent: () => sent };
  }

  it('is one server span, with the transactions as children of it and the call to the model proxy under them; the log lines carry the trace id', async () => {
    const exporter = await tracing();
    const { f, lines, sent } = await app();
    const res = await f.inject({ method: 'GET', url: '/api/things/42?token=hunter2' });
    expect(res.statusCode).toBe(200);
    await f.close();

    const spans = exporter.getFinishedSpans();
    const root = spans.find((s) => s.name === 'GET /api/things/:id');
    expect(root).toBeDefined();
    expect(root?.attributes).toMatchObject({ 'http.request.method': 'GET', 'http.route': '/api/things/:id', 'http.response.status_code': 200 });
    const tx = spans.filter((s) => s.name === 'db.transaction');
    expect(tx).toHaveLength(2);
    for (const t of tx) {
      expect(t.spanContext().traceId).toBe(root?.spanContext().traceId);
      expect(t.parentSpanContext?.spanId).toBe(root?.spanContext().spanId);
    }
    const llm = spans.find((s) => s.name === 'llm.chat');
    expect(llm?.parentSpanContext?.spanId).toBe(tx[1]?.spanContext().spanId);

    // the trace parent sent on is the llm span's: same trace, that span's id, sampled
    const parent = sent()['traceparent'];
    expect(parent).toBe(`00-${root?.spanContext().traceId}-${llm?.spanContext().spanId}-01`);
    expect(Object.keys(sent())).toEqual(['traceparent']);

    const traceId = root?.spanContext().traceId;
    const mine = lines.filter((l) => l['msg'] === 'handling' || l['msg'] === 'request completed');
    expect(mine.length).toBeGreaterThanOrEqual(2);
    for (const l of mine) expect(l['traceId']).toBe(traceId);

    // the raw address (and the token in its query) is not on any span
    expect(JSON.stringify(spans.map((s) => ({ n: s.name, a: s.attributes })))).not.toMatch(/hunter2|\/42/);
  });

  it('does not trace the probes', async () => {
    const exporter = await tracing();
    const { f } = await app();
    await f.inject({ method: 'GET', url: '/healthz' });
    await f.close();
    expect(exporter.getFinishedSpans()).toEqual([]);
  });

  it('a 500 marks the span as failed and records no message', async () => {
    const exporter = await tracing();
    const { f } = await app();
    expect((await f.inject({ method: 'GET', url: '/boom' })).statusCode).toBe(500);
    await f.close();
    const span = exporter.getFinishedSpans().find((s) => s.name === 'GET /boom');
    expect(span?.status.code).toBe(2);
    expect(span?.attributes['http.response.status_code']).toBe(500);
    expect(JSON.stringify([span?.attributes, span?.events, span?.status])).not.toMatch(/secret sentence/);
  });

  it('a request is always a new trace: an incoming traceparent is not adopted', async () => {
    const exporter = await tracing();
    const { f } = await app();
    await f.inject({ method: 'GET', url: '/api/things/1', headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' } });
    await f.close();
    expect(exporter.getFinishedSpans().find((s) => s.name === 'GET /api/things/:id')?.spanContext().traceId).not.toBe('0af7651916cd43dd8448eb211c80319c');
  });

  it('a sample ratio of 0 exports nothing and still costs the request nothing it can see', async () => {
    const exporter = await tracing(0);
    const { f, sent } = await app();
    const res = await f.inject({ method: 'GET', url: '/api/things/1' });
    expect(res.statusCode).toBe(200);
    await f.close();
    expect(exporter.getFinishedSpans()).toEqual([]);
    expect(sent()['traceparent']).toMatch(/-00$/);
  });
});

describe('a traced job', () => {
  it('is a trace of its own with the work as children; a failure keeps the error type and not the message', async () => {
    const exporter = await tracing();
    await traceRoot('job files.gc', { 'mt.job.queue': 'files.gc', 'mt.job.id': 'j1', 'mt.job.attempt': 1 }, () => traceSpan('db.transaction', {}, async () => undefined));
    await expect(
      traceRoot('job files.gc', { 'mt.job.queue': 'files.gc' }, async () => {
        throw new TypeError('row for nadia@example.com failed');
      }),
    ).rejects.toThrow(TypeError);
    const spans = exporter.getFinishedSpans();
    const jobs = spans.filter((s) => s.name === 'job files.gc');
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map((j) => j.spanContext().traceId)).size).toBe(2);
    const tx = spans.find((s) => s.name === 'db.transaction');
    expect(tx?.parentSpanContext?.spanId).toBe(jobs[0]?.spanContext().spanId);
    const failed = jobs.find((j) => j.status.code === 2);
    expect(failed?.attributes['error.type']).toBe('TypeError');
    expect(JSON.stringify([failed?.attributes, failed?.events, failed?.status])).not.toMatch(/nadia|example\.com/);
  });

  it('a poll outside any trace starts none', async () => {
    const exporter = await tracing();
    await traceSpan('db.transaction', {}, async () => undefined);
    expect(exporter.getFinishedSpans()).toEqual([]);
  });
});
