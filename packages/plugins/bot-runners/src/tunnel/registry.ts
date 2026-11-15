import { randomBytes } from 'node:crypto';
import type { PluginSocket } from '@manythreads/sdk';
import {
  TUNNEL_MAX_REQUEST_BYTES,
  TUNNEL_MAX_STREAMS,
  TUNNEL_MAX_UNREAD_BYTES,
  TUNNEL_RECONNECT_GRACE_MS,
  type BridgeHello,
  type SiteToBridge,
} from '@manythreads/shared';

// The site's half of the outbound tunnel (docs/plans/agents-anywhere.md §5.3): the connections of the enrolled servers that are open on THIS process, and `fetch` for
// one server, which sends a request down its socket and hands back a standard `Response` whose body is the frames that come back. The live site runs one replica, so
// a server's socket and the runs that use it are in one process (the `runners` plugin makes the same assumption).
//
// What the bridge or the site writes in a frame body is never logged here: a run request carries the run's token. The log line is the stream id, the method, the path
// (without its query), the status and the size.

/** A request that could not reach the server, in one plain sentence a run may fail with. */
export class TunnelUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TunnelUnavailable';
  }
}

/** The request headers that go to the bridge; `authorization` never does (the bridge's own handler is reached in memory with its own key). */
const FORWARDED_HEADERS = new Set(['content-type', 'accept', 'last-event-id', 'idempotency-key', 'traceparent', 'tracestate']);

/** A status the `Response` constructor accepts and that may carry a body. */
const bodyless = (status: number): boolean => status === 204 || status === 205 || status === 304;

export interface TunnelOptions {
  /** Test hook: how long a request waits for a server that dropped to come back. Default 60 s. */
  graceMs?: number;
  /** Test hook: the unread bytes after which a stream is closed. Default 8 MiB. */
  maxUnreadBytes?: number;
  /** Test hook: open requests per server. Default 64. */
  maxStreams?: number;
  /** One line per finished request: id, method, path, status, bytes. Never a body. */
  log?: (line: string) => void;
  now?: () => number;
}

interface HeadAnswer {
  status: number;
  headers: Record<string, string>;
}

/** One request in flight on a connection. */
class TunnelStream {
  bytes = 0;
  status = 0;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private done = false;
  private headSettled = false;
  readonly head: Promise<HeadAnswer>;
  private resolveHead!: (h: HeadAnswer) => void;
  private rejectHead!: (e: unknown) => void;
  readonly body: ReadableStream<Uint8Array>;

  constructor(
    readonly id: string,
    readonly method: string,
    readonly path: string,
    maxUnread: number,
    onCancel: () => void,
  ) {
    this.head = new Promise<HeadAnswer>((resolve, reject) => {
      this.resolveHead = resolve;
      this.rejectHead = reject;
    });
    this.head.catch(() => undefined);
    this.body = new ReadableStream<Uint8Array>(
      {
        start: (c) => {
          this.controller = c;
        },
        cancel: () => {
          if (this.done) return;
          this.done = true;
          onCancel();
        },
      },
      new ByteLengthQueuingStrategy({ highWaterMark: maxUnread }),
    );
  }

  get finished(): boolean {
    return this.done;
  }

  gotHead(h: HeadAnswer): void {
    if (this.headSettled) return;
    this.headSettled = true;
    this.status = h.status;
    this.resolveHead(h);
  }

  /** Answers false when the reader is more than `maxUnread` bytes behind: the caller then closes the stream. */
  push(bytes: Uint8Array): boolean {
    if (this.done || this.controller === null) return true;
    this.bytes += bytes.byteLength;
    this.controller.enqueue(bytes);
    const room = this.controller.desiredSize;
    return room === null || room >= 0;
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    try {
      this.controller?.close();
    } catch {
      /* already closed by a cancel */
    }
  }

  fail(err: Error): void {
    if (this.done) return;
    this.done = true;
    if (!this.headSettled) {
      this.headSettled = true;
      this.rejectHead(err);
    }
    try {
      this.controller?.error(err);
    } catch {
      /* the reader went away */
    }
  }
}

export interface BridgeConnection {
  readonly serverId: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly hello: BridgeHello;
  readonly socket: PluginSocket;
  readonly streams: Map<string, TunnelStream>;
  closed: boolean;
  /** Sends one frame; throws when the socket is gone. */
  send(frame: SiteToBridge): void;
  close(code: number, reason: string, why: 'closed' | 'silent' | 'revoked' | 'replaced' | 'protocol' | 'removed'): void;
}

export type { TunnelStream };

export class TunnelRegistry {
  private readonly conns = new Map<string, BridgeConnection>();
  /** When a server's connection last dropped (ms), so a request knows whether to wait for it to come back. */
  private readonly droppedAt = new Map<string, number>();
  private readonly waiters = new Map<string, Set<(c: BridgeConnection) => void>>();
  private readonly graceMs: number;
  private readonly maxUnread: number;
  private readonly maxStreams: number;
  private readonly log: (line: string) => void;
  private readonly now: () => number;

  constructor(options: TunnelOptions = {}) {
    this.graceMs = options.graceMs ?? TUNNEL_RECONNECT_GRACE_MS;
    this.maxUnread = options.maxUnreadBytes ?? TUNNEL_MAX_UNREAD_BYTES;
    this.maxStreams = options.maxStreams ?? TUNNEL_MAX_STREAMS;
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? Date.now;
  }

  get(serverId: string): BridgeConnection | undefined {
    const c = this.conns.get(serverId);
    return c && !c.closed ? c : undefined;
  }

  /** Registers `conn`; answers the connection it replaces (the caller closes it). */
  set(conn: BridgeConnection): BridgeConnection | undefined {
    const previous = this.conns.get(conn.serverId);
    this.conns.set(conn.serverId, conn);
    this.droppedAt.delete(conn.serverId);
    const waiting = this.waiters.get(conn.serverId);
    if (waiting) {
      this.waiters.delete(conn.serverId);
      for (const wake of waiting) wake(conn);
    }
    return previous;
  }

  /** Forgets `conn` when it is still the registered one (a newer connection of the same server stays). Fails its streams. */
  remove(conn: BridgeConnection, why: string): boolean {
    for (const stream of conn.streams.values()) stream.fail(new TunnelUnavailable(`the server ${conn.name} disconnected (${why})`));
    conn.streams.clear();
    if (this.conns.get(conn.serverId) !== conn) return false;
    this.conns.delete(conn.serverId);
    this.droppedAt.set(conn.serverId, this.now());
    return true;
  }

  /** Is the server connected, or did it drop so recently that a request still waits for it to come back? A run is refused at once when this is false. */
  reachable(serverId: string): boolean {
    if (this.get(serverId)) return true;
    const dropped = this.droppedAt.get(serverId);
    return dropped !== undefined && dropped + this.graceMs - this.now() > 0;
  }

  /** Servers connected on this process. */
  connectedIds(): string[] {
    return [...this.conns.entries()].filter(([, c]) => !c.closed).map(([id]) => id);
  }

  /** Close the open connection of a server (removed, key revoked). */
  disconnect(serverId: string, code: number, reason: string, why: 'revoked' | 'removed'): void {
    this.conns.get(serverId)?.close(code, reason, why);
  }

  /** The open connection, or after a drop one that comes back inside the grace; otherwise a plain refusal. */
  private async connectionFor(serverId: string, name: string, signal: AbortSignal | null | undefined): Promise<BridgeConnection> {
    const live = this.get(serverId);
    if (live) return live;
    const dropped = this.droppedAt.get(serverId);
    const left = dropped === undefined ? 0 : dropped + this.graceMs - this.now();
    if (left <= 0) throw new TunnelUnavailable(`the server ${name} is not connected`);
    return new Promise<BridgeConnection>((resolve, reject) => {
      const wake = (c: BridgeConnection): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(c);
      };
      const forget = (): void => {
        const set = this.waiters.get(serverId);
        set?.delete(wake);
        if (set?.size === 0) this.waiters.delete(serverId);
      };
      const timer = setTimeout(() => {
        forget();
        signal?.removeEventListener('abort', onAbort);
        reject(new TunnelUnavailable(`the server ${name} disconnected and did not come back`));
      }, left);
      timer.unref?.();
      const onAbort = (): void => {
        clearTimeout(timer);
        forget();
        reject(signal?.reason instanceof Error ? signal.reason : new DOMException('aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const set = this.waiters.get(serverId) ?? new Set();
      set.add(wake);
      this.waiters.set(serverId, set);
    });
  }

  /**
   * A `fetch` that sends every request to one server's bridge through its socket. The URL's host is ignored: only its path and query travel. Bodies must be text (JSON);
   * a response body is a stream, so an event stream stays one.
   */
  fetchFor(serverId: string, name: string): typeof fetch {
    return async (input, init = {}) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw);
      const method = (init.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'POST' && method !== 'PUT' && method !== 'DELETE') throw new TypeError(`the tunnel does not carry ${method}`);
      const body = init.body === undefined || init.body === null ? undefined : init.body;
      if (body !== undefined && typeof body !== 'string') throw new TypeError('the tunnel carries text bodies only');
      if (body !== undefined && Buffer.byteLength(body, 'utf8') > TUNNEL_MAX_REQUEST_BYTES) throw new TunnelUnavailable('the request is too large to send to the server');
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, key) => {
        if (FORWARDED_HEADERS.has(key.toLowerCase())) headers[key.toLowerCase()] = value;
      });
      const signal = init.signal ?? null;
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('aborted', 'AbortError');
      const conn = await this.connectionFor(serverId, name, signal);
      if (conn.streams.size >= this.maxStreams) throw new TunnelUnavailable(`the server ${name} has too many requests open`);
      const id = randomBytes(9).toString('base64url');
      const path = `${url.pathname}${url.search}`;
      const cancel = (): void => {
        if (!conn.streams.delete(id)) return;
        try {
          conn.send({ type: 'cancel', id });
        } catch {
          /* the socket is gone: nothing to cancel */
        }
      };
      const stream = new TunnelStream(id, method, url.pathname, this.maxUnread, cancel);
      conn.streams.set(id, stream);
      const onAbort = (): void => {
        stream.fail(signal?.reason instanceof Error ? signal.reason : new DOMException('aborted', 'AbortError'));
        cancel();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        conn.send({ type: 'request', id, method, path, headers, ...(body !== undefined ? { body } : {}) });
      } catch (err) {
        conn.streams.delete(id);
        signal?.removeEventListener('abort', onAbort);
        throw new TunnelUnavailable(`the request could not be sent to the server ${name}: ${err instanceof Error ? err.message : 'socket closed'}`);
      }
      let head: HeadAnswer;
      try {
        head = await stream.head;
      } catch (err) {
        signal?.removeEventListener('abort', onAbort);
        throw err;
      }
      signal?.removeEventListener('abort', onAbort);
      this.log(`tunnel ${name} ${id} ${method} ${url.pathname} -> ${head.status}`);
      const status = head.status >= 200 ? head.status : 502;
      if (bodyless(status)) {
        stream.end();
        conn.streams.delete(id);
        return new Response(null, { status, headers: head.headers });
      }
      return new Response(stream.body, { status, headers: head.headers });
    };
  }

  /** The frames of the bridge's answer reach the stream they belong to. */
  handleHead(conn: BridgeConnection, id: string, status: number, headers: Record<string, string>): void {
    conn.streams.get(id)?.gotHead({ status, headers });
  }

  handleData(conn: BridgeConnection, id: string, data: string): void {
    const stream = conn.streams.get(id);
    if (!stream) return;
    const ok = stream.push(Buffer.from(data, 'base64'));
    if (!ok) {
      // a reader that stopped reading: close the stream here and tell the bridge to stop sending
      conn.streams.delete(id);
      stream.fail(new TunnelUnavailable('the answer was not being read and was closed'));
      try {
        conn.send({ type: 'cancel', id });
      } catch {
        /* the socket is going anyway */
      }
    }
  }

  handleEnd(conn: BridgeConnection, id: string): void {
    const stream = conn.streams.get(id);
    if (!stream) return;
    conn.streams.delete(id);
    this.log(`tunnel ${conn.name} ${id} ${stream.method} ${stream.path} ended ${stream.status} ${stream.bytes}B`);
    stream.end();
  }

  handleError(conn: BridgeConnection, id: string, message: string): void {
    const stream = conn.streams.get(id);
    if (!stream) return;
    conn.streams.delete(id);
    stream.fail(new TunnelUnavailable(message));
  }
}
