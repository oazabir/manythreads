import { randomBytes } from 'node:crypto';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';

// The server half of the outbound tunnel (PLAN P26-12, docs/plans/agents-anywhere.md §5.3). The bridge dials the site, says what the machine is, and then answers the site's HTTP
// requests inside that one socket: each request is handed to the bridge's own request handler (a Unix socket in the state folder, with a key that exists only in this
// process), and the answer goes back as frames. The bridge listens on no port.
//
// The frames are defined once, in `@manythreads/shared` (runner/bridge-tunnel.ts); this file keeps their names as plain strings so the bundled bridge stays small.
// What a frame carries is never logged: a run request holds the run's token, an answer may hold a sign-in code. A log line says a stream id, the method, the path's first
// segment, the status and a size.

export const TUNNEL_CHUNK_BYTES = 64 * 1024;
const MAX_STREAMS = 64;
/** A socket whose unsent frames pass this many bytes makes the answer wait (the site is reading slowly). */
const SEND_BUFFER_LIMIT = 1024 * 1024;
const FORBIDDEN_REQUEST_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'authorization', 'upgrade', 'expect']);
const STREAM_ID = /^[A-Za-z0-9_-]{6,40}$/;

export interface TunnelHello {
  bridgeVersion: string;
  host: { hostname: string; system: string; arch: string };
  agents: Array<{ agent: 'claude-code' | 'codex' | 'hermes-acp'; version: string | null }>;
  allowFullAccess: boolean;
}

export interface TunnelOptions {
  /** `https://<site>`; `wss` is made from it. `ws` is only allowed with `insecure`. */
  siteUrl: string;
  /** The bridge key now (read again at every connection: a rotation changes it). */
  key: () => string;
  /** The bridge's own request handler, as a Unix socket path, and the key that opens it. */
  socketPath: string;
  internalKey: string;
  hello: () => TunnelHello | Promise<TunnelHello>;
  /** A new key came over the socket: write it where the next start reads it. Resolves once it is safely stored. */
  storeKey: (key: string) => Promise<void>;
  /** Test only: allow `ws://` to a local site. */
  insecure?: boolean;
  log?: (line: string) => void;
  /** Reconnect pauses in ms: the first, and the longest. Defaults 1000 and 30000. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** After the site refuses the key (close 1008): how long to wait before asking again with whatever key is stored. Default 5 minutes. */
  refusedWaitMs?: number;
}

export interface TunnelClient {
  /** Resolves when the first welcome arrived. Rejects only when the options are unusable. */
  connected(): Promise<void>;
  /** Connected to the site now? */
  isConnected(): boolean;
  close(): Promise<void>;
}

/** `https://site/` to `wss://site/api/bridge/connect`. Refuses anything but https/wss unless `insecure`. */
export function connectUrl(siteUrl: string, insecure: boolean): string {
  const u = new URL(siteUrl);
  if (u.protocol === 'https:' || u.protocol === 'wss:') u.protocol = 'wss:';
  else if ((u.protocol === 'http:' || u.protocol === 'ws:') && insecure) u.protocol = 'ws:';
  else throw new Error('the site address must be https:// (the tunnel carries a key); ws:// is only for tests');
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/api/bridge/connect`;
  u.search = '';
  u.hash = '';
  return u.toString();
}

/** A fresh random key for the in-process hand-off: nothing outside this process ever holds it. */
export const newInternalKey = (): string => randomBytes(32).toString('hex');

function flatHeaders(res: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers)) {
    if (v === undefined || k.length > 80) continue;
    const value = Array.isArray(v) ? v.join(', ') : v;
    out[k] = value.slice(0, 2000);
  }
  return out;
}

interface Live {
  req: ClientRequest;
  res: IncomingMessage | null;
  done: boolean;
}

export function startTunnel(options: TunnelOptions): TunnelClient {
  const log = options.log ?? (() => undefined);
  const url = connectUrl(options.siteUrl, options.insecure === true);
  const minBackoff = options.minBackoffMs ?? 1000;
  const maxBackoff = options.maxBackoffMs ?? 30_000;
  let closed = false;
  let current: WebSocket | null = null;
  let welcomed = false;
  let attempt = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let firstWelcome: (() => void) | null = null;
  const firstConnected = new Promise<void>((resolve) => {
    firstWelcome = resolve;
  });

  const connect = (): void => {
    if (closed) return;
    let key: string;
    try {
      key = options.key();
    } catch (err) {
      log(`tunnel: no key to connect with (${err instanceof Error ? err.message : 'error'})`);
      schedule(options.refusedWaitMs ?? 5 * 60_000);
      return;
    }
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${key}` }, maxPayload: 4 * 1024 * 1024, handshakeTimeout: 15_000 });
    current = ws;
    const streams = new Map<string, Live>();
    let heartbeat: NodeJS.Timeout | null = null;
    let lastFrameAt = Date.now();
    let beatMs = 20_000;
    let refused = false;
    let rotating = false;

    const send = (frame: Record<string, unknown>): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
    };
    const finishStream = (id: string): void => {
      streams.delete(id);
    };
    const failStream = (id: string, message: string): void => {
      const live = streams.get(id);
      if (!live || live.done) return;
      live.done = true;
      send({ type: 'error', id, message });
      live.req.destroy();
      finishStream(id);
    };

    const handleRequest = (frame: { id: string; method: string; path: string; headers: Record<string, string>; body?: string }): void => {
      if (!STREAM_ID.test(frame.id) || streams.has(frame.id)) return;
      if (streams.size >= MAX_STREAMS) {
        send({ type: 'error', id: frame.id, message: 'the bridge has too many requests open' });
        return;
      }
      const body = frame.body === undefined ? undefined : Buffer.from(frame.body, 'utf8');
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(frame.headers)) if (!FORBIDDEN_REQUEST_HEADERS.has(k.toLowerCase())) headers[k.toLowerCase()] = v;
      headers['authorization'] = `Bearer ${options.internalKey}`;
      if (body !== undefined) headers['content-length'] = String(body.length);
      const started = Date.now();
      const req = httpRequest({ socketPath: options.socketPath, method: frame.method, path: frame.path, headers });
      const live: Live = { req, res: null, done: false };
      streams.set(frame.id, live);
      log(`tunnel: ${frame.id} ${frame.method} /${frame.path.split('?')[0]!.split('/').filter(Boolean).slice(0, 3).join('/')}`);
      req.on('response', (res) => {
        live.res = res;
        send({ type: 'head', id: frame.id, status: res.statusCode ?? 502, headers: flatHeaders(res) });
        let total = 0;
        const pump = (chunk: Buffer): void => {
          for (let at = 0; at < chunk.length; at += TUNNEL_CHUNK_BYTES) {
            const piece = chunk.subarray(at, at + TUNNEL_CHUNK_BYTES);
            total += piece.length;
            send({ type: 'data', id: frame.id, data: piece.toString('base64') });
          }
          // a site that reads slowly makes the answer wait here instead of piling up in memory
          if (ws.bufferedAmount > SEND_BUFFER_LIMIT) {
            res.pause();
            const resume = setInterval(() => {
              if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount <= SEND_BUFFER_LIMIT / 4) {
                clearInterval(resume);
                if (!live.done) res.resume();
              }
            }, 25);
          }
        };
        res.on('data', pump);
        res.on('end', () => {
          if (live.done) return;
          live.done = true;
          send({ type: 'end', id: frame.id });
          finishStream(frame.id);
          log(`tunnel: ${frame.id} ${res.statusCode ?? 0} ${total}B ${Date.now() - started}ms`);
        });
        res.on('error', () => failStream(frame.id, 'the bridge could not finish the answer'));
        res.on('close', () => {
          if (!live.done && !res.complete) failStream(frame.id, 'the bridge could not finish the answer');
        });
      });
      req.on('error', () => failStream(frame.id, 'the bridge could not answer'));
      if (body !== undefined) req.end(body);
      else req.end();
    };

    const handleCancel = (id: string): void => {
      const live = streams.get(id);
      if (!live) return;
      live.done = true;
      // as if the client went away: the bridge's own `req.on('close')` drops the run's subscriber
      live.res?.destroy();
      live.req.destroy();
      finishStream(id);
    };

    const handleRotate = async (newKey: string): Promise<void> => {
      if (rotating) return;
      rotating = true;
      try {
        await options.storeKey(newKey);
      } catch {
        log('tunnel: the new key could not be stored; keeping the old one');
        rotating = false;
        return;
      }
      send({ type: 'rotated' });
      log('tunnel: key rotated; reconnecting');
      // the next connection reads the stored key
      setTimeout(() => ws.close(1000, 'rotated'), 200).unref();
    };

    ws.on('open', () => {
      void Promise.resolve(options.hello()).then((h) => {
        send({ type: 'hello', protocol: 1, bridgeVersion: h.bridgeVersion, host: h.host, agents: h.agents, allowFullAccess: h.allowFullAccess });
      }).catch(() => ws.close(1011, 'no hello'));
    });
    ws.on('message', (raw) => {
      lastFrameAt = Date.now();
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        ws.close(1002, 'bad frame');
        return;
      }
      switch (frame['type']) {
        case 'welcome': {
          welcomed = true;
          attempt = 0;
          const s = Number(frame['heartbeatSeconds']);
          beatMs = Number.isFinite(s) && s >= 5 && s <= 60 ? s * 1000 : 20_000;
          if (heartbeat) clearInterval(heartbeat);
          heartbeat = setInterval(() => {
            if (Date.now() - lastFrameAt > beatMs * 3) {
              log('tunnel: the site has been silent for three beats; reconnecting');
              ws.terminate();
              return;
            }
            send({ type: 'beat' });
          }, beatMs);
          heartbeat.unref();
          log(`tunnel: connected to the site as "${String(frame['name'] ?? '')}"`);
          firstWelcome?.();
          return;
        }
        case 'beat_ack':
          return;
        case 'request':
          return handleRequest(frame as unknown as Parameters<typeof handleRequest>[0]);
        case 'cancel':
          return handleCancel(String(frame['id']));
        case 'rotate':
          if (typeof frame['key'] === 'string' && /^mtb_[0-9a-f]{64}$/.test(frame['key'])) void handleRotate(frame['key']);
          return;
        default:
          return;
      }
    });
    ws.on('unexpected-response', (_req, res) => {
      // the site said no before the upgrade (a proxy in front, a wrong path): nothing about the body is logged
      log(`tunnel: the site answered ${res.statusCode ?? 0} to the connection`);
      res.resume();
    });
    ws.on('error', (err) => {
      log(`tunnel: ${err instanceof Error ? err.message.replace(/mtb_[0-9a-f]+/g, 'mtb_…').slice(0, 120) : 'connection error'}`);
    });
    ws.on('close', (code) => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      for (const [id, live] of streams) {
        live.done = true;
        live.res?.destroy();
        live.req.destroy();
        streams.delete(id);
      }
      if (current === ws) current = null;
      if (closed) return;
      if (code === 1008) {
        refused = true;
        log('tunnel: the site does not accept this key; waiting before asking again');
      }
      welcomed = false;
      if (refused) schedule(options.refusedWaitMs ?? 5 * 60_000);
      else schedule(Math.min(maxBackoff, minBackoff * 2 ** Math.min(attempt++, 10)));
    });
  };

  const schedule = (ms: number): void => {
    if (closed) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, ms);
    reconnectTimer.unref?.();
  };

  connect();
  return {
    connected: () => firstConnected,
    isConnected: () => welcomed && current !== null && current.readyState === WebSocket.OPEN,
    close: async () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const ws = current;
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        await new Promise<void>((resolve) => {
          ws.once('close', () => resolve());
          ws.close(1000, 'bridge stopping');
          setTimeout(() => {
            ws.terminate();
            resolve();
          }, 1000).unref();
        });
      }
    },
  };
}
