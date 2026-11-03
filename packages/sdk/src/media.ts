import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { MEDIA_TOKEN_MAX_SECONDS } from '@manythreads/shared';
import type { ProviderImpl } from './types.ts';

// The `media` provider (extension point `provider.media`, PLAN P15-02): the server that carries the audio of a voice room. `media-livekit` is the real one; `media-fake`
// (test servers only) is a deterministic stand-in. The `meetings` plugin is the only caller: it asks for the provider when a request arrives, never in `register`.
//
//   ctx.providers.get<MediaProvider>('media', 'livekit')
//
// What the provider promises, whoever it is:
//  * A token lives at most ten minutes (`MEDIA_TOKEN_MAX_SECONDS`). The caller asks for a new one while the person may still read the channel.
//  * A bot never gets a token of its own. The one exception is the note-taker's server participant (P15-18): a token that can only subscribe to audio and can never
//    publish, minted by the meetings plugin and never handed to a bot run. `assertTokenRequest` is that rule in one place; every provider calls it first.
//  * A webhook is believed only after its signature checks out; `verifyWebhook` answers null for anything else.
//  * With no server set up the provider says so (`status().configured` is false) and `createRoom`, `token` and the other calls throw `MediaNotConfiguredError`.

/** Who a token is for. `kind: 'bot'` is accepted only for a listen-only grant (see `assertTokenRequest`). */
export interface MediaActor {
  /** The actor id: also the identity the media server knows the participant by. */
  id: string;
  kind: 'person' | 'bot';
  /** Shown to the others in the room. */
  displayName: string;
}

/** What a token lets its holder do in the room. Audio only for now; video adds sources, not rooms (PLAN phase 17). */
export interface MediaGrants {
  /** May send audio (a microphone). */
  canPublish: boolean;
  /** May receive the others' audio. */
  canSubscribe: boolean;
  /** The note-taker: receives audio only, never sends and never shows in the room's list of speakers. A bot's token must have this set and `canPublish` false. */
  listenOnly?: boolean;
}

export interface MediaRoom {
  /** The provider's name for the room: the meeting id. */
  name: string;
  /** The provider that made it. */
  provider: string;
}

export interface MediaToken {
  provider: string;
  /** The address the person's browser connects to (`wss://…`). */
  url: string;
  /** A credential. Never logged, never stored. */
  token: string;
  identity: string;
  roomName: string;
  expiresAt: Date;
}

/** What the media server told us, reduced to what the meetings plugin acts on. */
export interface MediaWebhookEvent {
  /** The provider's own id for the notice (for logs; may repeat if the provider retries). */
  id: string;
  kind: 'room_started' | 'room_finished' | 'participant_joined' | 'participant_left' | 'other';
  room: string;
  /** The participant's identity (the actor id we put in the token); null for a room notice. */
  identity: string | null;
  at: Date;
}

export interface MediaStatus {
  configured: boolean;
  /** Plain words for a person when `configured` is false; null otherwise. */
  reason: string | null;
}

export interface MediaProvider extends ProviderImpl {
  /** `livekit`, `fake`. */
  id: string;
  /** Whether calls can be made right now. Reads configuration only; no network call. */
  status(): MediaStatus;
  /** Makes the room on the server (idempotent: asking again for the same name is not an error). */
  createRoom(input: { name: string; maxParticipants?: number }): Promise<MediaRoom>;
  /** A token for `actor` to join `room` with `grants`. Lives at most ten minutes. Throws `MediaTokenRefusedError` for a request that breaks the rules above. */
  token(actor: MediaActor, room: string, grants: MediaGrants, options?: { ttlSeconds?: number }): Promise<MediaToken>;
  /** Closes the room and drops everyone in it. Not an error when the room is already gone. */
  closeRoom(room: string): Promise<void>;
  /** Drops one participant (their token is not revoked, but it expires within ten minutes and the caller refuses to mint another). Not an error when they are not there. */
  kick(room: string, identity: string): Promise<void>;
  /** The notice the server signed, or null when the signature is missing, wrong, or the body is not a notice. Never throws for bad input. */
  verifyWebhook(headers: Readonly<Record<string, string | undefined>>, rawBody: Uint8Array | string): MediaWebhookEvent | null;
}

/** Thrown by every call of a provider that has no media server set up. `message` is in plain words. */
export class MediaNotConfiguredError extends Error {
  constructor(message = 'Voice rooms are not set up on this server. Ask a workspace admin to connect a media server.') {
    super(message);
    this.name = 'MediaNotConfiguredError';
  }
}

/** Thrown for a token request the rules refuse (a bot asking for a token that could publish, a lifetime over ten minutes is clamped instead). */
export class MediaTokenRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaTokenRefusedError';
  }
}

/** The lifetime a token gets: what was asked for, between one second and ten minutes. */
export function clampTokenTtl(ttlSeconds: number | undefined): number {
  const asked = ttlSeconds === undefined || !Number.isFinite(ttlSeconds) ? MEDIA_TOKEN_MAX_SECONDS : Math.floor(ttlSeconds);
  return Math.min(Math.max(asked, 1), MEDIA_TOKEN_MAX_SECONDS);
}

/**
 * The rules every provider applies to a token request before it signs anything: an identity and a room name are present, and a bot gets a token only if it
 * can never publish and is flagged listen-only (the note-taker's server participant). Throws `MediaTokenRefusedError`.
 */
export function assertTokenRequest(actor: MediaActor, room: string, grants: MediaGrants): void {
  if (!actor.id || !room) throw new MediaTokenRefusedError('A token needs a person and a room.');
  if (actor.kind === 'bot' && (grants.canPublish || grants.listenOnly !== true || !grants.canSubscribe)) {
    throw new MediaTokenRefusedError('A bot never gets a media token of its own, except a listen-only one for the note-taker.');
  }
  if (grants.listenOnly === true && grants.canPublish) throw new MediaTokenRefusedError('A listen-only token cannot publish.');
}

/**
 * A deterministic stand-in for tests: no network, a fixed address, tokens that carry their own claims, and a record of every call so a test can assert what the
 * plugin asked for. Webhooks are signed with `FAKE_WEBHOOK_SECRET` (see `signFakeWebhook`). `now` is the clock (inject the server's).
 */
export const FAKE_MEDIA_URL = 'wss://media.fake.invalid';
export const FAKE_WEBHOOK_SECRET = 'fake-media-webhook-secret';

export interface FakeMediaProvider extends MediaProvider {
  id: 'fake';
  /** Every room created and not closed, by name. */
  readonly rooms: Map<string, { maxParticipants: number | null }>;
  /** Every token minted, oldest first (claims only; the token string is derived from them). */
  readonly tokens: Array<{ identity: string; room: string; grants: MediaGrants; expiresAt: Date; displayName: string; kind: 'person' | 'bot' }>;
  readonly kicked: Array<{ room: string; identity: string }>;
  readonly closed: string[];
  /** Pretend the server is not set up. */
  setConfigured(configured: boolean): void;
  /** Read the claims back out of a token made by this provider (null for anything else). */
  decode(token: string): { identity: string; room: string; exp: number; canPublish: boolean; canSubscribe: boolean; listenOnly: boolean } | null;
}

export function createFakeMediaProvider(options: { now?: () => Date } = {}): FakeMediaProvider {
  const now = options.now ?? (() => new Date());
  let configured = true;
  const rooms = new Map<string, { maxParticipants: number | null }>();
  const tokens: FakeMediaProvider['tokens'] = [];
  const kicked: FakeMediaProvider['kicked'] = [];
  const closed: string[] = [];
  const need = (): void => {
    if (!configured) throw new MediaNotConfiguredError();
  };
  const encode = (claims: Record<string, unknown>): string => {
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const sig = createHmac('sha256', FAKE_WEBHOOK_SECRET).update(body).digest('base64url');
    return `fake.${body}.${sig}`;
  };
  return {
    id: 'fake',
    rooms,
    tokens,
    kicked,
    closed,
    setConfigured(value) {
      configured = value;
    },
    status: () => (configured ? { configured: true, reason: null } : { configured: false, reason: 'The fake media server is switched off.' }),
    async createRoom({ name, maxParticipants }) {
      need();
      if (!rooms.has(name)) rooms.set(name, { maxParticipants: maxParticipants ?? null });
      return { name, provider: 'fake' };
    },
    async token(actor, room, grants, opts) {
      need();
      assertTokenRequest(actor, room, grants);
      const expiresAt = new Date(now().getTime() + clampTokenTtl(opts?.ttlSeconds) * 1000);
      tokens.push({ identity: actor.id, room, grants: { ...grants }, expiresAt, displayName: actor.displayName, kind: actor.kind });
      const token = encode({
        sub: actor.id,
        room,
        exp: Math.floor(expiresAt.getTime() / 1000),
        pub: grants.canPublish,
        sub_: grants.canSubscribe,
        listen: grants.listenOnly === true,
      });
      return { provider: 'fake', url: FAKE_MEDIA_URL, token, identity: actor.id, roomName: room, expiresAt };
    },
    async closeRoom(room) {
      need();
      rooms.delete(room);
      closed.push(room);
    },
    async kick(room, identity) {
      need();
      kicked.push({ room, identity });
    },
    verifyWebhook(headers, rawBody) {
      const signature = headers['x-fake-signature'];
      if (!signature) return null;
      const bytes = typeof rawBody === 'string' ? Buffer.from(rawBody) : Buffer.from(rawBody);
      const expected = createHmac('sha256', FAKE_WEBHOOK_SECRET).update(bytes).digest('hex');
      const a = Buffer.from(signature);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
      try {
        const body = JSON.parse(bytes.toString('utf8')) as { id?: string; kind?: string; room?: string; identity?: string | null; at?: string };
        if (typeof body.room !== 'string') return null;
        const kinds = ['room_started', 'room_finished', 'participant_joined', 'participant_left'] as const;
        const kind = kinds.find((k) => k === body.kind) ?? 'other';
        return { id: String(body.id ?? ''), kind, room: body.room, identity: typeof body.identity === 'string' ? body.identity : null, at: body.at ? new Date(body.at) : now() };
      } catch {
        return null;
      }
    },
    decode(token) {
      const parts = token.split('.');
      if (parts.length !== 3 || parts[0] !== 'fake') return null;
      const expected = createHmac('sha256', FAKE_WEBHOOK_SECRET).update(parts[1]!).digest('base64url');
      if (parts[2] !== expected) return null;
      const c = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { sub: string; room: string; exp: number; pub: boolean; sub_: boolean; listen: boolean };
      return { identity: c.sub, room: c.room, exp: c.exp, canPublish: c.pub, canSubscribe: c.sub_, listenOnly: c.listen };
    },
  };
}

/** The signature header value a test sends with a body to `FakeMediaProvider.verifyWebhook` (HMAC-SHA256, hex). */
export function signFakeWebhook(rawBody: string): string {
  return createHmac('sha256', FAKE_WEBHOOK_SECRET).update(rawBody).digest('hex');
}

/** SHA-256 of a body, base64: the claim LiveKit puts in a webhook's token (exported for `media-livekit` and its tests). */
export function sha256Base64(body: Uint8Array | string): string {
  return createHash('sha256').update(body).digest('base64');
}
