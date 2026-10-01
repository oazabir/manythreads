import { WsEnvelope, WsErrorEnvelope, type ErrorCode } from '@majlis/shared';

/** The part of a socket the hub needs. */
export interface WsPeer {
  send(data: string): void;
}

export type WsHandler = (
  message: WsEnvelope,
  peer: WsPeer,
) => WsEnvelope | undefined | Promise<WsEnvelope | undefined>;

export interface WsHub {
  /** Register the handler for one message type. */
  on(type: string, handler: WsHandler): void;
  /** Validate and dispatch one raw inbound frame. Invalid frames get an error envelope back; nothing throws. */
  receive(peer: WsPeer, raw: string): Promise<void>;
  /** Validate an outbound envelope against the schema, then send it. Throws on a bug (invalid envelope). */
  send(peer: WsPeer, envelope: WsEnvelope): void;
}

const errorEnvelope = (
  id: string,
  code: ErrorCode,
  message: string,
  path?: (string | number)[],
): WsErrorEnvelope =>
  WsErrorEnvelope.parse({ type: 'error', id, payload: { code, message, ...(path ? { path } : {}) } });

/** Hub for schema-checked `{type,id,payload}` envelopes, validated in both directions. */
export function createWsHub(): WsHub {
  const handlers = new Map<string, WsHandler>();

  const reply = (peer: WsPeer, env: WsEnvelope | WsErrorEnvelope): void => {
    peer.send(JSON.stringify(env));
  };

  return {
    on(type, handler) {
      handlers.set(type, handler);
    },
    send(peer, envelope) {
      reply(peer, WsEnvelope.parse(envelope));
    },
    async receive(peer, raw) {
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        reply(peer, errorEnvelope('', 'validation_failed', 'Message is not valid JSON'));
        return;
      }
      const parsed = WsEnvelope.safeParse(json);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const id = typeof (json as { id?: unknown } | null)?.id === 'string' ? (json as { id: string }).id.slice(0, 100) : '';
        reply(
          peer,
          errorEnvelope(
            id,
            'validation_failed',
            issue ? issue.message : 'Invalid envelope',
            issue ? issue.path.map((p) => (typeof p === 'symbol' ? String(p) : p)) : [],
          ),
        );
        return;
      }
      const message = parsed.data;
      const handler = handlers.get(message.type);
      if (!handler) {
        reply(peer, errorEnvelope(message.id, 'not_found', `Unknown message type "${message.type}"`, ['type']));
        return;
      }
      try {
        const out = await handler(message, peer);
        if (out) {
          const checked = WsEnvelope.safeParse(out);
          if (!checked.success) throw checked.error;
          reply(peer, checked.data);
        }
      } catch {
        reply(peer, errorEnvelope(message.id, 'internal', 'Internal error'));
      }
    },
  };
}
