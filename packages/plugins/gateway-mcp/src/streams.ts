import { Readable } from 'node:stream';
import { MCP_TOOLS_LIST_CHANGED_METHOD, McpToolsListChanged } from '@manythreads/shared';

// The event streams of the bots' MCP endpoint (PLAN P14-22): `GET` with `Accept: text/event-stream` and the bot's token opens one, and the only thing it
// ever carries is `notifications/tools/list_changed`, which makes the client call `tools/list` again. This file is the part that holds the open
// streams of THIS process; deciding when to push, and what to ask the database, is the caller's (`hub.deps`).
//
//   * the first frame is sent the moment a stream opens, so a Hermes that reconnects after a restart or a deploy re-lists and picks up what the new
//     version added;
//   * a `: keepalive` comment every 25 s keeps proxies from closing an idle stream; a stream ends by itself after 30 minutes (the client reconnects) and at
//     once when its token is revoked;
//   * at most 4 streams per bot and a cap for the whole process, an excess one is refused (the route answers 429 with `Retry-After`);
//   * a reader that cannot keep up is dropped, never buffered without limit: over `maxBufferedBytes` unread, or with anything unread at two keepalive
//     times in a row (a frame is tiny, so a stalled client would take hours to reach the byte limit);
//   * across replicas a change is seen through the database: every replica reads the bot's change counter every `pollMs` and pushes when it moved
//     (nothing is shared in process memory), and `wake()` makes the replica that saw the change first do it at once.

export const STREAM_LIMITS = {
  perBot: 4,
  global: 2000,
  keepaliveMs: 25_000,
  maxAgeMs: 30 * 60_000,
  /** How often the counters are read. */
  pollMs: 2_000,
  /** How often the open streams' tokens are checked for revocation. */
  validityMs: 10_000,
  /** What may sit unread in one stream before it is dropped. A frame is about 90 bytes. */
  maxBufferedBytes: 16 * 1024,
  /** The granularity of the timer that does all of the above. */
  tickMs: 1_000,
} as const;

export type StreamLimits = { -readonly [K in keyof typeof STREAM_LIMITS]: number };

export interface StreamHubDeps {
  /** The change counter of each bot (a bot with no row is absent). */
  versions(botIds: readonly string[]): Promise<Map<string, string>>;
  /** Of these token hashes (hex), the ones that still resolve to a bot. */
  validTokens(hashes: readonly string[]): Promise<Set<string>>;
  warn(line: string): void;
}

interface Held {
  botId: string;
  tokenHash: string;
  stream: Readable;
  openedAt: number;
  lastWrite: number;
  /** Keepalive times in a row at which the client had read nothing of what was sent. */
  stalls: number;
}

export type OpenResult = { ok: true; stream: Readable } | { ok: false; reason: 'bot_cap' | 'global_cap' };

export interface StreamHub {
  /** Opens a stream for `botId`; `baseline` is the bot's change counter as read just before, so a change after it is not missed. */
  open(botId: string, tokenHash: string, baseline: string): OpenResult;
  /** Why a stream for this bot would be refused right now, or null: checked before any database work is spent on a request that will be turned away. */
  refusal(botId: string): 'bot_cap' | 'global_cap' | null;
  /** Look for changes now rather than at the next tick (this replica just wrote one). With `tokens`, check that the open streams' tokens still resolve too. */
  wake(options?: { tokens?: boolean }): void;
  /** Sends `list_changed` on every open stream of the bot in this process; answers how many got it. */
  push(botId: string): number;
  count(botId?: string): number;
  stop(): void;
}

const FRAME = `event: message\ndata: ${JSON.stringify(McpToolsListChanged.parse({ jsonrpc: '2.0', method: MCP_TOOLS_LIST_CHANGED_METHOD }))}\n\n`;
const KEEPALIVE = ': keepalive\n\n';

export function createStreamHub(deps: StreamHubDeps, overrides: Partial<StreamLimits> = {}, now: () => number = Date.now): StreamHub {
  const limits: StreamLimits = { ...STREAM_LIMITS, ...overrides };
  const held = new Set<Held>();
  const byBot = new Map<string, Set<Held>>();
  /** The counter each bot's streams were last told about. */
  const seen = new Map<string, string>();
  let timer: NodeJS.Timeout | undefined;
  let lastPoll = 0;
  let lastValidity = 0;
  let busy = false;
  let again = false;
  let againTokens = false;

  const write = (h: Held, text: string): void => {
    if (h.stream.destroyed || h.stream.readableEnded) return;
    h.stream.push(text);
    h.lastWrite = now();
    // The proxy or the client is not reading: nothing here waits for it.
    if (h.stream.readableLength > limits.maxBufferedBytes) h.stream.destroy();
  };

  const release = (h: Held): void => {
    if (!held.delete(h)) return;
    const set = byBot.get(h.botId);
    set?.delete(h);
    if (set && set.size === 0) {
      byBot.delete(h.botId);
      seen.delete(h.botId);
    }
    if (held.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const end = (h: Held): void => {
    if (!h.stream.destroyed && !h.stream.readableEnded) h.stream.push(null);
    release(h);
  };

  const push = (botId: string): number => {
    let sent = 0;
    for (const h of byBot.get(botId) ?? []) {
      write(h, FRAME);
      sent += 1;
    }
    return sent;
  };

  const poll = async (): Promise<void> => {
    const botIds = [...byBot.keys()];
    if (botIds.length === 0) return;
    const versions = await deps.versions(botIds);
    for (const botId of botIds) {
      const version = versions.get(botId);
      if (version === undefined || seen.get(botId) === version) continue;
      // a bot whose streams all closed while the read was out has no baseline any more: nothing to tell
      if (!byBot.has(botId)) continue;
      seen.set(botId, version);
      push(botId);
    }
  };

  const checkTokens = async (): Promise<void> => {
    const hashes = [...new Set([...held].map((h) => h.tokenHash))];
    if (hashes.length === 0) return;
    const valid = await deps.validTokens(hashes);
    for (const h of [...held]) if (!valid.has(h.tokenHash)) end(h);
  };

  const tick = async (force: boolean, tokens = false): Promise<void> => {
    const at = now();
    for (const h of [...held]) {
      if (at - h.openedAt >= limits.maxAgeMs) end(h);
      else if (at - h.lastWrite >= limits.keepaliveMs) {
        // nothing of what was sent has been read since the last keepalive: after two in a row the client is gone or stuck
        h.stalls = h.stream.readableLength > 0 ? h.stalls + 1 : 0;
        if (h.stalls >= 2) {
          h.stream.destroy();
          release(h);
        } else write(h, KEEPALIVE);
      }
    }
    if (busy) {
      // a change was written while a read was out: look again once it is back, or this replica would wait for the next tick
      if (force) again = true;
      if (tokens) againTokens = true;
      return;
    }
    busy = true;
    try {
      if (force || at - lastPoll >= limits.pollMs) {
        lastPoll = at;
        await poll();
      }
      if (tokens || at - lastValidity >= limits.validityMs) {
        lastValidity = at;
        await checkTokens();
      }
    } catch (err) {
      deps.warn(`gateway-mcp: the event streams could not read the database: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300));
    } finally {
      busy = false;
      if (again || againTokens) {
        const t = againTokens;
        again = false;
        againTokens = false;
        void tick(true, t);
      }
    }
  };

  return {
    refusal(botId) {
      if (held.size >= limits.global) return 'global_cap';
      return (byBot.get(botId)?.size ?? 0) >= limits.perBot ? 'bot_cap' : null;
    },
    open(botId, tokenHash, baseline) {
      const refused = this.refusal(botId);
      if (refused !== null) return { ok: false, reason: refused };
      const stream = new Readable({ read() {} });
      const at = now();
      const h: Held = { botId, tokenHash, stream, openedAt: at, lastWrite: at, stalls: 0 };
      held.add(h);
      let set = byBot.get(botId);
      if (!set) byBot.set(botId, (set = new Set()));
      set.add(h);
      if (!seen.has(botId)) seen.set(botId, baseline);
      stream.once('close', () => release(h));
      stream.once('end', () => release(h));
      write(h, FRAME);
      if (!timer) {
        lastPoll = at;
        lastValidity = at;
        timer = setInterval(() => void tick(false), limits.tickMs);
        timer.unref();
      }
      return { ok: true, stream };
    },
    wake(options) {
      if (held.size > 0) void tick(true, options?.tokens === true);
    },
    push,
    count: (botId) => (botId === undefined ? held.size : (byBot.get(botId)?.size ?? 0)),
    stop() {
      for (const h of [...held]) h.stream.destroy();
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
