import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A receiver on a real socket that records every request it gets and answers as told: the stand-in for the door of the webhooks plugin and the bridge. */
export interface Received {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

export interface Receiver {
  url: string;
  received: Received[];
  /** What the next requests are answered with (default 200 `{}`). */
  answer: (request: Received) => { status: number; headers?: Record<string, string>; body?: string };
  close(): Promise<void>;
}

export async function startReceiver(): Promise<Receiver> {
  const received: Received[] = [];
  const receiver: Receiver = {
    url: '',
    received,
    answer: () => ({ status: 200, body: '{}' }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(',') : (v ?? '');
      const request: Received = { method: req.method ?? '', path: req.url ?? '', headers, body: Buffer.concat(chunks).toString('utf8') };
      received.push(request);
      const a = receiver.answer(request);
      res.writeHead(a.status, a.headers ?? {});
      res.end(a.body ?? '');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  receiver.url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return receiver;
}

/** What a test reads out of an answer it checks field by field: the shape is the stand-in's, so it is not typed here. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

/** A JSON call with a Bearer token (or none). */
export async function call(url: string, init: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; json: Json; text: string; headers: Headers }> {
  const r = await fetch(url, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    redirect: 'manual',
  });
  const text = await r.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: r.status, json, text, headers: r.headers };
}
