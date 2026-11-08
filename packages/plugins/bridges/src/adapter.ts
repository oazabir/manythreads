import type { BridgeProvider, BridgeRefusalReason, BridgeSecretName } from '@manythreads/shared';

// The seam between the bridge core and one chat service (PLAN Bundle D, P16-09, decisions D24 to D27). The core (inbound.ts, outbound.ts, identity.ts, dm.ts) never knows a service's
// wire format: an adapter verifies a request, reads a body into plain messages and sends one. Adapters are pure with respect to the database; they get their credentials as an
// argument and never log them. Everything an adapter returns from `parse` is hostile text and is cleaned by the core before it is stored or posted.

/** The account an adapter works for. The secrets are in the clear for the duration of one call only. */
export interface BridgeAccountRef {
  id: string;
  workspaceId: string;
  provider: BridgeProvider;
  /** The bot's handle at the service (`@acme_bot`), when the admin gave it; used for deep links. */
  handle: string | null;
  /** The service's app id (a WhatsApp phone number id, a Slack app id, a Teams app id). */
  externalAppId: string | null;
  secrets: Readonly<Partial<Record<BridgeSecretName, string>>>;
}

/** One request to the public door, as the core got it. The body is the RAW bytes, because a signature is over them. */
export interface BridgeRequest {
  method: 'GET' | 'POST';
  /** Header names in lower case. */
  headers: Readonly<Record<string, string>>;
  query: Readonly<Record<string, string>>;
  rawBody: Uint8Array;
  /** The server's clock, milliseconds. */
  now: number;
}

export type BridgeVerifyResult = { ok: true } | { ok: false; reason: Extract<BridgeRefusalReason, 'bad_signature'> };

/** A person or a group at the service where a message was said. `kind` `private` is a direct chat with the bot; `group` is a group, channel or team. */
export interface InboundChat {
  id: string;
  kind: 'private' | 'group';
  /** The chat's name as the service shows it; used only in the admin's "linked to" line. */
  title: string | null;
}

export interface InboundMessage {
  /** The service's id of this delivery or update: the dedupe key. */
  updateId: string;
  /** The service's id of the message, for a later reply or a loop guard. */
  externalId: string | null;
  chat: InboundChat;
  /** The service's id of the person who said it, and how the service names them (a label only; never used as an identity). */
  sender: { id: string; label: string };
  /** Hostile text, as the service delivered it. */
  text: string;
  /** True when the text is a command to the bridge (`/start`, `/connect`, `/unlink`, `/bot`) rather than something to post. */
  command: { name: 'start' | 'connect' | 'unlink' | 'bot'; argument: string } | null;
  /** When the service says it was said, milliseconds; null when it does not. */
  at: number | null;
}

export interface BridgeAdapter {
  provider: BridgeProvider;
  /** Is this request really from the service? Over the RAW body, constant time, with the service's replay window. A failure stores nothing. */
  verify(account: BridgeAccountRef, req: BridgeRequest): BridgeVerifyResult;
  /**
   * Gets ready to verify: fetches what `verify` needs and cannot get itself because it is synchronous (Teams' signing keys). Called by the door just before `verify`; it never throws and
   * says nothing about the request, so a failure here only makes `verify` refuse.
   */
  prepare?(account: BridgeAccountRef, req: BridgeRequest): Promise<void>;
  /** Read a verified body into messages. A body that is not a message (a read receipt, a join notice) gives an empty list. Never throws for a shape it does not know. */
  parse(account: BridgeAccountRef, body: unknown): InboundMessage[];
  /**
   * A verified body that is the service's own check of the address, not a message (Slack's `url_verification`): the plain answer to send back, or null when the body is not one.
   * Asked after `verify` and before `parse`.
   */
  handshake?(account: BridgeAccountRef, body: unknown): string | null;
  /** Send text to a chat; the service's id of the sent message. The core has already cut it to length and run it past the egress chain. */
  send(account: BridgeAccountRef, chat: string, text: string): Promise<string>;
  /** The answer to a `GET` URL check (WhatsApp's verification challenge), or null when the request is not a valid challenge. */
  challenge?(account: BridgeAccountRef, req: BridgeRequest): string | null;
  /**
   * Turn the account on at the service: check the credentials and, where the service lets us, tell it where to send events (`callbackUrl`, with the account's `inbound_secret` as the
   * secret it must send back). Returns what the service says the account is called, when it says. Throws `BridgeSendError`. A service where this is done by hand (WhatsApp) only checks.
   */
  connect?(account: BridgeAccountRef, callbackUrl: string): Promise<{ handle: string | null; externalAppId: string | null }>;
  /** Turn it off at the service (remove the callback). Best effort; a failure is not an error for the caller. */
  disconnect?(account: BridgeAccountRef): Promise<void>;
}
