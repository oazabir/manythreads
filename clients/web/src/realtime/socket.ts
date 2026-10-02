import { WsEnvelope } from '@manythreads/shared';

/*
 * One WebSocket per tab (PLAN P3-13). The server sends pushes to a signed-in person's sockets without any subscribe step, so
 * "resubscribing" after a drop is just reconnecting. What this class adds: reconnect with exponential backoff and jitter, a ping
 * every 25 s with a silence timeout (a half-open connection is closed and replaced), and a `reconnected` signal so the stores
 * fetch what they missed while the socket was down. Everything it needs from the outside (socket, timers, clock) is injected so the
 * unit tests drive it without a browser.
 */

export type SocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

export type Push = { type: string; id: string; payload: Record<string, unknown> };
export type RealtimeStatus = 'idle' | 'connecting' | 'open' | 'waiting';

export type RealtimeDeps = {
  url: () => string;
  createSocket: (url: string) => SocketLike;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  random: () => number;
};

export const BACKOFF_FIRST_MS = 500;
export const BACKOFF_MAX_MS = 15_000;
export const PING_EVERY_MS = 25_000;
export const SILENCE_MS = 45_000;
const OPEN = 1;

/** The wait before reconnect attempt `attempt` (0 is the first): 0.5 s, 1 s, 2 s ... up to 15 s, give or take a quarter. */
export function backoffDelay(attempt: number, random: number): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.min(attempt, 10));
  return Math.round(base * (0.75 + random * 0.5));
}

export class RealtimeClient {
  private socket: SocketLike | null = null;
  private attempt = 0;
  private everOpened = false;
  private wanted = false;
  private retry: unknown = null;
  private ping: unknown = null;
  private silence: unknown = null;
  private pings = 0;
  private current: RealtimeStatus = 'idle';
  private readonly pushes = new Set<(push: Push) => void>();
  private readonly statuses = new Set<(status: RealtimeStatus) => void>();
  private readonly reopens = new Set<() => void>();

  constructor(private readonly deps: RealtimeDeps) {}

  get status(): RealtimeStatus {
    return this.current;
  }

  /** Every valid push envelope. Returns the way to stop listening. */
  onPush(listener: (push: Push) => void): () => void {
    this.pushes.add(listener);
    return () => this.pushes.delete(listener);
  }
  onStatus(listener: (status: RealtimeStatus) => void): () => void {
    this.statuses.add(listener);
    return () => this.statuses.delete(listener);
  }
  /** Fires when the socket opens again after a drop (not the first time): catch up on what was missed. */
  onReconnected(listener: () => void): () => void {
    this.reopens.add(listener);
    return () => this.reopens.delete(listener);
  }

  start(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.connect();
  }

  stop(): void {
    this.wanted = false;
    this.clearTimers();
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      try {
        s.close(1000, 'bye');
      } catch {
        /* already closed */
      }
    }
    this.set('idle');
  }

  /** The tab became visible or the network came back: do not wait out the backoff. */
  nudge(): void {
    if (!this.wanted || this.current === 'open' || this.current === 'connecting') return;
    this.attempt = 0;
    this.connect();
  }

  private set(next: RealtimeStatus): void {
    if (this.current === next) return;
    this.current = next;
    for (const l of [...this.statuses]) l(next);
  }

  private clearTimers(): void {
    for (const h of [this.retry, this.ping, this.silence]) if (h !== null) this.deps.clearTimeout(h);
    this.retry = this.ping = this.silence = null;
  }

  private connect(): void {
    if (!this.wanted) return;
    if (this.retry !== null) this.deps.clearTimeout(this.retry);
    this.retry = null;
    this.set('connecting');
    let socket: SocketLike;
    try {
      socket = this.deps.createSocket(this.deps.url());
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      const reconnect = this.everOpened;
      this.everOpened = true;
      this.attempt = 0;
      this.set('open');
      this.armTimers();
      if (reconnect) for (const l of [...this.reopens]) l();
    };
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      this.armSilence();
      if (typeof ev.data !== 'string') return;
      let raw: unknown;
      try {
        raw = JSON.parse(ev.data);
      } catch {
        return;
      }
      const env = WsEnvelope.safeParse(raw);
      if (!env.success || env.data.type === 'pong') return;
      for (const l of [...this.pushes]) l(env.data);
    };
    socket.onerror = () => {
      /* onclose follows */
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearTimers();
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    if (!this.wanted) return;
    this.set('waiting');
    const delay = backoffDelay(this.attempt, this.deps.random());
    this.attempt += 1;
    this.retry = this.deps.setTimeout(() => {
      this.retry = null;
      this.connect();
    }, delay);
  }

  private armTimers(): void {
    if (this.ping !== null) this.deps.clearTimeout(this.ping);
    const tick = (): void => {
      const s = this.socket;
      if (s && s.readyState === OPEN) {
        this.pings += 1;
        try {
          s.send(JSON.stringify({ type: 'ping', id: `p${this.pings}`, payload: {} }));
        } catch {
          /* the close handler takes over */
        }
      }
      this.ping = this.deps.setTimeout(tick, PING_EVERY_MS);
    };
    this.ping = this.deps.setTimeout(tick, PING_EVERY_MS);
    this.armSilence();
  }

  private armSilence(): void {
    if (this.silence !== null) this.deps.clearTimeout(this.silence);
    this.silence = this.deps.setTimeout(() => {
      // nothing, not even a pong, for too long: the connection is dead even if the browser has not noticed
      this.silence = null;
      const s = this.socket;
      if (!s) return;
      this.socket = null;
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      try {
        s.close(4000, 'silent');
      } catch {
        /* gone */
      }
      this.clearTimers();
      this.scheduleRetry();
    }, SILENCE_MS);
  }
}

/** The tab's socket address: same origin, `/ws`. */
export function defaultSocketUrl(loc: { protocol: string; host: string } = window.location): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;
}

export function browserDeps(): RealtimeDeps {
  return {
    url: () => defaultSocketUrl(),
    createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (h) => window.clearTimeout(h as number),
    random: () => Math.random(),
  };
}
