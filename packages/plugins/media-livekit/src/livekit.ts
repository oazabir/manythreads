import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  MediaNotConfiguredError,
  assertTokenRequest,
  clampTokenTtl,
  sha256Base64,
  type MediaActor,
  type MediaGrants,
  type MediaProvider,
  type MediaWebhookEvent,
} from '@manythreads/sdk';
import { startLivekitListener } from './listener.ts';

// LiveKit, hand-written over node:crypto and fetch (no SDK package is needed for three calls and a signature check). What it speaks:
//  * An access token is an HS256 JWT signed with the API secret: `iss` the API key, `sub` the identity, `video` the grants of one room.
//  * The server API is Twirp over HTTP: POST <http url>/twirp/livekit.RoomService/<Method> with a JSON body and a short-lived admin JWT as the bearer.
//  * A webhook is a POST whose `Authorization` header is a JWT signed with the same secret; its `sha256` claim is the base64 SHA-256 of the body.
// docs/plugins/media-livekit.md and docs/spikes/voice.md say what is verified here and what only a real LiveKit server can show.

export interface LivekitConfig {
  /** The address browsers connect to: `wss://livekit.example.com`. */
  url: string;
  apiKey: string;
  /** Never logged, never returned. */
  apiSecret: string;
  /** Where the server API is reached from this server (`https://…`); derived from `url` when absent (inside a cluster it is often an internal address). */
  apiUrl: string;
  /** Where the note-taker's listener connects from this server (`ws://…`); `MANYTHREADS_LIVEKIT_LISTEN_URL`, else the public address. Inside a cluster this is the service address. */
  listenUrl: string;
}

/** Why the provider is not configured, in plain words; null when it is. Reads names, never prints a value. */
export function livekitConfigProblem(env: Readonly<Record<string, string | undefined>>): string | null {
  const url = (env['MANYTHREADS_LIVEKIT_URL'] ?? '').trim();
  const key = (env['MANYTHREADS_LIVEKIT_API_KEY'] ?? '').trim();
  const secret = (env['MANYTHREADS_LIVEKIT_API_SECRET'] ?? '').trim();
  if (!url && !key && !secret) return 'Voice rooms are not set up on this server. Ask a workspace admin to connect a LiveKit media server (the address, an API key and its secret).';
  if (!url) return 'The media server address is missing. Ask a workspace admin to set it.';
  if (!/^(wss?|https?):\/\/[^\s/]+/i.test(url)) return 'The media server address must start with wss:// (or ws:// for a local test).';
  if (!key) return 'The media server API key is missing. Ask a workspace admin to set it.';
  if (!secret) return 'The media server API secret is missing. Ask a workspace admin to set it.';
  if (secret.length < 32) return 'The media server API secret is too short (use at least 32 characters).';
  return null;
}

/** The settings, or null when something is missing (see `livekitConfigProblem`). */
export function livekitConfigFromEnv(env: Readonly<Record<string, string | undefined>>): LivekitConfig | null {
  if (livekitConfigProblem(env) !== null) return null;
  const url = (env['MANYTHREADS_LIVEKIT_URL'] ?? '').trim().replace(/\/+$/, '');
  const explicit = (env['MANYTHREADS_LIVEKIT_API_URL'] ?? '').trim().replace(/\/+$/, '');
  const wsUrl = url.replace(/^http/i, 'ws');
  const listen = (env['MANYTHREADS_LIVEKIT_LISTEN_URL'] ?? '').trim().replace(/\/+$/, '');
  return {
    url: wsUrl,
    listenUrl: listen ? listen.replace(/^http/i, 'ws') : wsUrl,
    apiKey: (env['MANYTHREADS_LIVEKIT_API_KEY'] ?? '').trim(),
    apiSecret: (env['MANYTHREADS_LIVEKIT_API_SECRET'] ?? '').trim(),
    apiUrl: explicit || url.replace(/^ws/i, 'http'),
  };
}

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/** An HS256 JWT. Exported for the tests. */
export function signJwt(claims: Record<string, unknown>, secret: string): string {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(claims);
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

/** The claims of an HS256 JWT signed with `secret` and not expired at `nowSec`; null for anything else. Never throws. */
export function verifyJwt(token: string, secret: string, nowSec: number): Record<string, unknown> | null {
  const parts = token.trim().split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as { alg?: unknown };
    if (header.alg !== 'HS256') return null;
    const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
    const given = Buffer.from(parts[2]!, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof claims['exp'] === 'number' && claims['exp'] < nowSec) return null;
    if (typeof claims['nbf'] === 'number' && claims['nbf'] > nowSec + 60) return null;
    return claims;
  } catch {
    return null;
  }
}

export interface LivekitOptions {
  /** `process.env` by default; a test passes its own. Read on every call, so a change takes effect without a restart. */
  env?: () => Readonly<Record<string, string | undefined>>;
  /** Test hook: the worker file the listener starts (see `startLivekitListener`). */
  listenerWorkerUrl?: URL;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Milliseconds before a call to the server API gives up. */
  timeoutMs?: number;
}

/** What the server API said, when it did not say yes. The message is plain; the body is never copied into it. */
export class LivekitApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'LivekitApiError';
    this.status = status;
  }
}

const EVENT_KINDS: Readonly<Record<string, MediaWebhookEvent['kind']>> = {
  room_started: 'room_started',
  room_finished: 'room_finished',
  participant_joined: 'participant_joined',
  participant_left: 'participant_left',
};

export function createLivekitProvider(options: LivekitOptions = {}): MediaProvider {
  const listenerWorkerUrl = options.listenerWorkerUrl;
  const env = options.env ?? ((): Readonly<Record<string, string | undefined>> => process.env);
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? ((): Date => new Date());
  const timeoutMs = options.timeoutMs ?? 5000;

  const config = (): LivekitConfig => {
    const c = livekitConfigFromEnv(env());
    if (!c) throw new MediaNotConfiguredError(livekitConfigProblem(env()) ?? undefined);
    return c;
  };

  /** One Twirp call with an admin token for `room` (the token lasts one minute). */
  const call = async (c: LivekitConfig, method: string, grant: Record<string, unknown>, body: Record<string, unknown>): Promise<void> => {
    const nowSec = Math.floor(now().getTime() / 1000);
    const bearer = signJwt({ iss: c.apiKey, nbf: nowSec - 5, exp: nowSec + 60, video: grant }, c.apiSecret);
    let res: Response;
    try {
      res = await doFetch(`${c.apiUrl}/twirp/livekit.RoomService/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new LivekitApiError(0, 'The media server did not answer.');
    }
    if (res.ok) {
      await res.arrayBuffer().catch(() => undefined);
      return;
    }
    await res.arrayBuffer().catch(() => undefined);
    // Twirp answers 404 `not_found` for a room or a participant that is not there: for close and kick that is the state we wanted.
    throw new LivekitApiError(res.status, res.status === 401 || res.status === 403 ? 'The media server refused our key.' : `The media server answered ${res.status}.`);
  };

  const provider: MediaProvider = {
    id: 'livekit',

    status() {
      const problem = livekitConfigProblem(env());
      return problem === null ? { configured: true, reason: null } : { configured: false, reason: problem };
    },

    async createRoom({ name, maxParticipants }) {
      const c = config();
      // An empty room is closed by the server after two minutes at the latest; ours closes it sooner (the meetings plugin's job).
      await call(c, 'CreateRoom', { roomCreate: true }, { name, empty_timeout: 120, ...(maxParticipants ? { max_participants: maxParticipants } : {}) });
      return { name, provider: 'livekit' };
    },

    async token(actor: MediaActor, room: string, grants: MediaGrants, opts) {
      assertTokenRequest(actor, room, grants);
      const c = config();
      const ttl = clampTokenTtl(opts?.ttlSeconds);
      const nowSec = Math.floor(now().getTime() / 1000);
      const exp = nowSec + ttl;
      const listenOnly = grants.listenOnly === true;
      const token = signJwt(
        {
          iss: c.apiKey,
          sub: actor.id,
          name: actor.displayName,
          nbf: nowSec - 5,
          exp,
          video: {
            room,
            roomJoin: true,
            canPublish: grants.canPublish && !listenOnly,
            canPublishData: false,
            canSubscribe: grants.canSubscribe,
            // the note-taker listens without appearing in the room
            hidden: listenOnly,
          },
        },
        c.apiSecret,
      );
      return { provider: 'livekit', url: c.url, token, identity: actor.id, roomName: room, expiresAt: new Date(exp * 1000) };
    },

    async closeRoom(room) {
      const c = config();
      try {
        await call(c, 'DeleteRoom', { roomCreate: true, roomAdmin: true, room }, { room });
      } catch (err) {
        if (err instanceof LivekitApiError && err.status === 404) return;
        throw err;
      }
    },

    async kick(room, identity) {
      const c = config();
      try {
        await call(c, 'RemoveParticipant', { roomAdmin: true, room }, { room, identity });
      } catch (err) {
        if (err instanceof LivekitApiError && err.status === 404) return;
        throw err;
      }
    },

    /**
     * The note-taker's server participant (P15-18, P15-19): joins as a hidden participant with a token that can only subscribe, in a worker thread of its own, and
     * hears the listed people only. Its identity is never an actor id (the webhook would treat an unknown actor id as a person who must be dropped).
     */
    async listen(room, options) {
      const c = config();
      const who = options.listener ?? { identity: `notetaker:${room}`, displayName: 'Note-taker' };
      const minted = await provider.token({ id: who.identity, kind: 'bot', displayName: who.displayName }, room, { canPublish: false, canSubscribe: true, listenOnly: true });
      return startLivekitListener({ url: c.listenUrl, token: minted.token, options, ...(listenerWorkerUrl ? { workerUrl: listenerWorkerUrl } : {}) });
    },

    verifyWebhook(headers, rawBody) {
      const c = livekitConfigFromEnv(env());
      if (!c) return null;
      const auth = headers['authorization'];
      if (!auth) return null;
      const claims = verifyJwt(auth.replace(/^Bearer\s+/i, ''), c.apiSecret, Math.floor(now().getTime() / 1000));
      if (!claims || claims['iss'] !== c.apiKey || typeof claims['sha256'] !== 'string') return null;
      const bytes = typeof rawBody === 'string' ? Buffer.from(rawBody) : rawBody;
      // the claim binds the signature to this body; a replay with another body fails here
      const want = Buffer.from(claims['sha256']);
      const got = Buffer.from(sha256Base64(bytes));
      if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
      try {
        const body = JSON.parse(Buffer.from(bytes).toString('utf8')) as {
          id?: unknown;
          event?: unknown;
          createdAt?: unknown;
          room?: { name?: unknown };
          participant?: { identity?: unknown };
        };
        const room = body.room?.name;
        if (typeof room !== 'string' || room === '') return null;
        const kind = typeof body.event === 'string' ? (EVENT_KINDS[body.event] ?? 'other') : 'other';
        const identity = typeof body.participant?.identity === 'string' ? body.participant.identity : null;
        const created = typeof body.createdAt === 'number' || typeof body.createdAt === 'string' ? Number(body.createdAt) : NaN;
        return { id: typeof body.id === 'string' ? body.id : '', kind, room, identity, at: Number.isFinite(created) && created > 0 ? new Date(created * 1000) : now() };
      } catch {
        return null;
      }
    },
  };
  return provider;
}
