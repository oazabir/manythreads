import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { HttpError, type HttpRequest, type HttpResponse } from '@manythreads/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_PROXY_BODY_BYTES, runProxyHandlers } from '../src/run-proxy.ts';

// The run-scoped model proxy (PLAN P6-06): an agent on a runner calls `/api/llm/runs/<runId>/v1/...` with its run token as the bearer; the server
// swaps in the bot's key and forwards to LiteLLM. These tests pin who gets through (the wrong, closed or another run's token never does), that the
// bot's key and nothing of the caller's token reaches the upstream, and that a streamed answer arrives as the upstream sends it, not buffered.

const RUN = '11111111-1111-4111-8111-111111111111';
const OTHER_RUN = '22222222-2222-4222-8222-222222222222';
const BOT = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'run-token-abc123';
const BOT_KEY = 'sk-bot-virtual-key';

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  body: string;
}

let upstream: Server;
let upstreamUrl = '';
let seen: Seen[] = [];
let upstreamClosedEarly = false;

beforeAll(async () => {
  upstream = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization, body });
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'smart' }] }));
        return;
      }
      if (req.url === '/v1/chat/completions' && body.includes('"hang-forever"')) return; // never answers
      if (body.includes('"bad-key"')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Authentication Error, Invalid proxy server token passed' } }));
        return;
      }
      if (body.includes('"refuse"')) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'budget reached' } }));
        return;
      }
      if (body.includes('"stream":true')) {
        // Two events a moment apart: a proxy that buffers delivers them together, after the second.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
        const timer = setTimeout(() => {
          res.write('data: {"choices":[{"delta":{"content":"second"}}]}\n\ndata: [DONE]\n\n');
          res.end();
        }, 400);
        res.on('close', () => {
          if (!res.writableEnded) upstreamClosedEarly = true;
          clearTimeout(timer);
        });
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'c1', choices: [{ message: { role: 'assistant', content: 'hello' } }] }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((resolve) => upstream.close(resolve));
});

const sha = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/** The handlers with a run table of one open run and one bot key. `open` flips to model a closed or expired run. */
function handlers(options: { rejected?: string[]; open?: boolean; key?: string | null; base?: string; timeoutMs?: number; perRunPerMinute?: number; token?: string } = {}) {
  const open = options.open ?? true;
  return runProxyHandlers({
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.perRunPerMinute === undefined ? {} : { perRunPerMinute: options.perRunPerMinute }),
    resolveRun: async (hash) => (open && hash.toString('hex') === sha(TOKEN) ? { runId: RUN, botId: BOT } : null),
    botKey: async (botId) => (botId === BOT ? (options.key === undefined ? BOT_KEY : options.key) : null),
    upstreamBase: () => options.base ?? upstreamUrl,
    ...(options.rejected ? { keyRejected: async (botId: string) => void options.rejected?.push(botId) } : {}),
  });
}

const request = (init: { runId?: string; authorization?: string | null; body?: string }): HttpRequest => ({
  params: { runId: init.runId ?? RUN },
  query: {},
  body: undefined,
  headers: init.authorization === null ? {} : { authorization: init.authorization ?? `Bearer ${TOKEN}` },
  ip: '127.0.0.1',
  caller: null,
  stream: Readable.from([Buffer.from(init.body ?? '{"model":"smart","messages":[]}')]),
});

const refusal = async (call: Promise<HttpResponse>): Promise<HttpError> => {
  const err = await call.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(HttpError);
  return err as HttpError;
};

const readAll = async (res: HttpResponse): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of res.body as Readable) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
};

describe('who may call the run proxy', () => {
  it('answers 401 to a wrong token, a missing header, another scheme and a malformed token, and calls nothing upstream', async () => {
    seen = [];
    const h = handlers();
    for (const authorization of ['Bearer not-the-token', null, 'Basic abc', 'Bearer', 'Bearer a b', `Bearer ${TOKEN}x`]) {
      expect((await refusal(h.chat(request({ authorization })))).status, String(authorization)).toBe(401);
      expect((await refusal(h.models(request({ authorization })))).status, String(authorization)).toBe(401);
    }
    expect(seen).toEqual([]);
  });

  it('answers 401 to the right token on a closed, expired or revoked run', async () => {
    seen = [];
    expect((await refusal(handlers({ open: false }).chat(request({})))).status).toBe(401);
    expect((await refusal(handlers({ open: false }).models(request({})))).status).toBe(401);
    expect(seen).toEqual([]);
  });

  it("answers 401 when the URL names another run than the token's", async () => {
    seen = [];
    const err = await refusal(handlers().chat(request({ runId: OTHER_RUN })));
    expect(err.status).toBe(401);
    // the same words as every other refusal: a probe cannot tell which check it failed
    expect(err.message).toBe((await refusal(handlers().chat(request({ authorization: 'Bearer nope' })))).message);
    expect(seen).toEqual([]);
  });

  it('answers 503 (not a key) when the bot has no key or no gateway is configured', async () => {
    seen = [];
    expect((await refusal(handlers({ key: null }).chat(request({})))).status).toBe(503);
    expect((await refusal(handlers({ base: '' }).chat(request({})))).status).toBe(503);
    expect(seen).toEqual([]);
  });

  it('refuses a body over the limit with 413 before anything is sent upstream', async () => {
    seen = [];
    const big = Readable.from((function* () {
      for (let sent = 0; sent <= MAX_PROXY_BODY_BYTES; sent += 1024 * 1024) yield Buffer.alloc(1024 * 1024, 97);
    })());
    const req = { ...request({}), stream: big };
    expect((await refusal(handlers().chat(req))).status).toBe(413);
    expect(seen).toEqual([]);
  });
});

describe('what the proxy forwards', () => {
  it("puts the bot's key on the upstream call, never the run token, and passes the body and the answer through", async () => {
    seen = [];
    const body = '{"model":"smart","messages":[{"role":"user","content":"hi"}]}';
    const res = await handlers().chat(request({ body }));
    expect(res.status).toBe(200);
    expect(res.headers?.['content-type']).toBe('application/json');
    expect(JSON.parse(await readAll(res))).toMatchObject({ choices: [{ message: { content: 'hello' } }] });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/v1/chat/completions', authorization: `Bearer ${BOT_KEY}`, body });
    expect(JSON.stringify(seen)).not.toContain(TOKEN);
  });

  it('lists models with the bot key', async () => {
    seen = [];
    const res = await handlers().models(request({}));
    expect(JSON.parse(await readAll(res))).toEqual({ object: 'list', data: [{ id: 'smart' }] });
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/v1/models', authorization: `Bearer ${BOT_KEY}` });
  });

  it("passes the upstream's refusal through with its status", async () => {
    const res = await handlers().chat(request({ body: '{"model":"smart","note":"refuse"}' }));
    expect(res.status).toBe(429);
    expect(await readAll(res)).toContain('budget reached');
  });

  it('streams server-sent events as they arrive: the first event is readable before the second exists', async () => {
    const started = Date.now();
    const res = await handlers().chat(request({ body: '{"model":"smart","stream":true}' }));
    expect(res.headers?.['content-type']).toBe('text/event-stream');
    const iterator = (res.body as Readable)[Symbol.asyncIterator]();
    const first = await iterator.next();
    const firstAt = Date.now() - started;
    expect(Buffer.from(first.value as Uint8Array).toString('utf8')).toContain('first');
    expect(firstAt).toBeLessThan(300); // the upstream waits 400 ms before the second event
    let rest = '';
    for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) rest += Buffer.from(next.value as Uint8Array).toString('utf8');
    expect(rest).toContain('second');
    expect(rest).toContain('[DONE]');
  });

  it('stops the upstream call when the reader goes away mid-stream', async () => {
    upstreamClosedEarly = false;
    const res = await handlers().chat(request({ body: '{"model":"smart","stream":true}' }));
    const body = res.body as Readable;
    await body[Symbol.asyncIterator]().next(); // the first event
    body.destroy();
    const deadline = Date.now() + 3000;
    while (!upstreamClosedEarly && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(upstreamClosedEarly).toBe(true);
  });

  it('answers 502 when the gateway cannot be reached', async () => {
    const err = await refusal(handlers({ base: 'http://127.0.0.1:1' }).chat(request({})));
    expect(err.status).toBe(502);
  });

  it('drops the keys that name a destination or a credential before forwarding, and keeps the rest', async () => {
    seen = [];
    const body = JSON.stringify({
      model: 'smart', messages: [{ role: 'user', content: 'hi' }], temperature: 0.2,
      api_base: 'http://evil.example', base_url: 'http://evil.example', api_key: 'sk-theirs', api_version: 'x', custom_llm_provider: 'openai', extra_headers: { 'x-a': '1' },
    });
    await readAll(await handlers().chat(request({ body })));
    const forwarded = JSON.parse(seen[0]!.body) as Record<string, unknown>;
    expect(forwarded).toEqual({ model: 'smart', messages: [{ role: 'user', content: 'hi' }], temperature: 0.2 });
    expect(seen[0]!.authorization).toBe(`Bearer ${BOT_KEY}`);
  });

  it('answers 400 to a body that is not a JSON object, without calling upstream', async () => {
    seen = [];
    for (const body of ['not json', '[1]', 'null', '"s"']) expect((await refusal(handlers().chat(request({ body })))).status, body).toBe(400);
    expect(seen).toEqual([]);
  });

  it('gives up on an upstream that never answers (502 after the timeout)', async () => {
    const started = Date.now();
    const err = await refusal(handlers({ timeoutMs: 300 }).chat(request({ body: '{"model":"smart","note":"hang-forever"}' })));
    expect(err.status).toBe(502);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('limits each run on its own: one run over its limit gets 429 while another run is untouched', async () => {
    const hash = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
    const other = 'run-token-other-run';
    const h = runProxyHandlers({
      perRunPerMinute: 2,
      resolveRun: async (buf) => (buf.toString('hex') === hash(TOKEN) ? { runId: RUN, botId: BOT } : buf.toString('hex') === hash(other) ? { runId: OTHER_RUN, botId: BOT } : null),
      botKey: async () => BOT_KEY,
      upstreamBase: () => upstreamUrl,
    });
    await readAll(await h.models(request({})));
    await readAll(await h.models(request({})));
    expect((await refusal(h.models(request({})))).status).toBe(429);
    // another run id (its own token, its own URL) is not affected by the first one's bucket
    await readAll(await h.models(request({ runId: OTHER_RUN, authorization: `Bearer ${other}` })));
  });

  it('slows a flood of failed authentications from one address (61st → 429) while a valid run from that address is still served', async () => {
    const h = handlers();
    for (let i = 0; i < 60; i += 1) expect((await refusal(h.models(request({ authorization: `Bearer guess-${i}` })))).status).toBe(401);
    expect((await refusal(h.models(request({ authorization: 'Bearer guess-61' })))).status).toBe(429);
    expect((await refusal(h.models(request({ authorization: null })))).status).toBe(429);
    const ok = await h.models(request({}));
    expect(ok.status).toBe(200);
    await readAll(ok);
    // another address is not affected
    const elsewhere = { ...request({ authorization: 'Bearer nope' }), ip: '10.9.9.9' };
    expect((await refusal(h.models(elsewhere))).status).toBe(401);
  });
});

describe('a key the proxy does not know', () => {
  it("reports the bot when the upstream answers 401, still passes the answer through, and does not report a 429", async () => {
    const rejected: string[] = [];
    const h = handlers({ rejected });
    const res = await h.chat(request({ body: '{"model":"smart","messages":[{"content":"bad-key"}]}' }));
    expect(res.status).toBe(401);
    expect(rejected).toEqual([BOT]);
    await h.chat(request({ body: '{"model":"smart","messages":[{"content":"refuse"}]}' }));
    expect(rejected).toEqual([BOT]);
  });
});
