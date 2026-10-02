import { randomUUID } from 'node:crypto';
import { WsEnvelope } from '@manythreads/shared';
import type pg from 'pg';
import { listen } from '../outbox/listen.ts';
import type { WsPeer } from './ws-hub.ts';

/** The Postgres channel every server replica listens on. */
export const REALTIME_CHANNEL = 'manythreads_realtime';

/** Postgres limits a NOTIFY payload to 8000 bytes; stay well under it. */
export const REALTIME_MAX_BYTES = 7_000;

/** One push: who gets it, and the `{ type, payload }` of the WebSocket envelope. */
export interface RealtimeMessage {
  workspaceId: string;
  personId: string;
  type: string;
  payload: Record<string, unknown>;
}

type Queryable = { query(text: string, values?: readonly unknown[]): Promise<unknown> };

/**
 * Queues pushes in `tx`: `pg_notify` is delivered when the transaction commits (and never if it rolls back), to every server
 * replica that listens, so a person connected to another replica still gets it. One statement for all messages.
 */
export async function publishRealtime(tx: Queryable, messages: readonly RealtimeMessage[]): Promise<void> {
  if (messages.length === 0) return;
  const payloads = messages.map((m) => {
    const text = JSON.stringify(m);
    if (Buffer.byteLength(text) > REALTIME_MAX_BYTES) {
      throw new RangeError(`Realtime payload for "${m.type}" is larger than ${REALTIME_MAX_BYTES} bytes: push an id and let the client fetch the rest`);
    }
    return text;
  });
  await tx.query('SELECT pg_notify($1, p) FROM unnest($2::text[]) AS p', [REALTIME_CHANNEL, payloads]);
}

export interface Realtime {
  /** Register a socket for a person; returns the function that forgets it (call it when the socket closes). */
  attach(personId: string, peer: WsPeer): () => void;
  /** Send to the sockets of one person connected to THIS process. Returns how many were written to. */
  deliver(message: RealtimeMessage): number;
  /** Start listening for pushes from every replica (one dedicated connection from `pool`). Idempotent. */
  start(pool: pg.Pool): Promise<void>;
  /** Stop listening and drop every registered socket reference. */
  stop(): Promise<void>;
  /** Sockets registered in this process (all people, or one). */
  connections(personId?: string): number;
}

/** Per-process registry of open sockets by person, plus the LISTEN loop that feeds it. */
export function createRealtime(): Realtime {
  const sockets = new Map<string, Set<WsPeer>>();
  let stopListening: (() => Promise<void>) | undefined;

  const deliver = (message: RealtimeMessage): number => {
    const peers = sockets.get(message.personId);
    if (!peers || peers.size === 0) return 0;
    const frame = JSON.stringify(WsEnvelope.parse({ type: message.type, id: randomUUID(), payload: message.payload }));
    let sent = 0;
    for (const peer of peers) {
      try {
        peer.send(frame);
        sent += 1;
      } catch {
        // A socket that is closing: its close handler detaches it.
      }
    }
    return sent;
  };

  return {
    attach(personId, peer) {
      let peers = sockets.get(personId);
      if (!peers) sockets.set(personId, (peers = new Set()));
      peers.add(peer);
      return () => {
        const set = sockets.get(personId);
        if (!set) return;
        set.delete(peer);
        if (set.size === 0) sockets.delete(personId);
      };
    },
    deliver,
    async start(pool) {
      if (stopListening) return;
      stopListening = await listen(pool, REALTIME_CHANNEL, (raw) => {
        try {
          const parsed = JSON.parse(raw) as RealtimeMessage;
          if (typeof parsed.personId === 'string' && typeof parsed.type === 'string') deliver(parsed);
        } catch {
          // Not ours or malformed: ignore.
        }
      });
    },
    async stop() {
      const stop = stopListening;
      stopListening = undefined;
      sockets.clear();
      if (stop) await stop();
    },
    connections(personId) {
      if (personId !== undefined) return sockets.get(personId)?.size ?? 0;
      let n = 0;
      for (const set of sockets.values()) n += set.size;
      return n;
    },
  };
}
