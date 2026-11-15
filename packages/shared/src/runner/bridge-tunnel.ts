import { z } from 'zod';
import { BotServerAgent, BotServerHost } from '../entities/bot-server.ts';
import { BotServerId } from '../ids.ts';

// The wire protocol between the site and an enrolled server's agent bridge (PLAN P26-12, docs/plans/agents-anywhere.md §5.3). The bridge opens ONE outbound WebSocket
// to `GET /api/bridge/connect` (a bearer bridge key in the upgrade request) and everything below travels over it as JSON text frames, one object per frame. The site
// never connects to the machine, so a server behind a firewall works and the bridge listens on no port. Only the site's requests to the bridge travel in it; what the
// bridge needs from the site (a push credential, a kubeconfig) is an ordinary HTTPS call with the bridge key or the run's token.
//
//   bridge → site   hello      the first frame: the machine, the bridge's version and the agents it found
//   site → bridge   welcome    accepted: the server, how often to beat
//   bridge → site   beat       every `heartbeatSeconds`; the site checks the key again on each one and answers `beat_ack`
//   site → bridge   request    one HTTP request for the bridge's own request handler (an `id` names the stream); the body is text, at most 1 MiB
//   bridge → site   head       the answer's status and headers
//   bridge → site   data       a piece of the answer's body (base64, at most 64 KiB of bytes); an event stream is many of these
//   bridge → site   end        the answer is complete
//   bridge → site   error      the request could not be answered (one plain sentence)
//   site → bridge   cancel     the site gave up on that request: the bridge closes it as if the client went away
//   site → bridge   rotate     a new key; the bridge writes it, answers `rotated` and reconnects with it
//
// A frame's body is never logged on either side: a run request holds the run's token.

export const BRIDGE_TUNNEL_VERSION = 1;
/** How often the bridge beats, and how many beats of silence end a connection. */
export const TUNNEL_HEARTBEAT_SECONDS = 20;
/** A request body at most this many bytes (the bridge's own limit). */
export const TUNNEL_MAX_REQUEST_BYTES = 1024 * 1024;
/** An answer is sent in pieces of at most this many bytes. */
export const TUNNEL_CHUNK_BYTES = 64 * 1024;
/** The largest message the site accepts on the tunnel's socket (the rest of the site's sockets take 64 KiB). A data frame is the chunk in base64 inside a small JSON envelope: this leaves 40 KiB of room. */
export const TUNNEL_MAX_FRAME_BYTES = 128 * 1024;
/** Open requests at most this many per server. */
export const TUNNEL_MAX_STREAMS = 64;
/** A stream whose unread pieces on the site pass this many bytes is closed (a reader that stopped reading). */
export const TUNNEL_MAX_UNREAD_BYTES = 8 * 1024 * 1024;
/** How long the site waits for a server that dropped to come back before a request to it fails. */
export const TUNNEL_RECONNECT_GRACE_MS = 60_000;

/** A bridge key: `mtb_` and 256 random bits as hex. Shown once, kept on the site as a hash. */
export const BRIDGE_KEY_PATTERN = /^mtb_[0-9a-f]{64}$/;
/** An enrolment code: `mte_` and 160 random bits as hex. Single use, valid 15 minutes. */
export const ENROL_CODE_PATTERN = /^mte_[0-9a-f]{40}$/;

const StreamId = z.string().regex(/^[A-Za-z0-9_-]{6,40}$/);

export const BridgeHello = z.strictObject({
  type: z.literal('hello'),
  protocol: z.literal(BRIDGE_TUNNEL_VERSION),
  bridgeVersion: z.string().max(40),
  host: BotServerHost,
  agents: z.array(BotServerAgent).max(8),
  allowFullAccess: z.boolean(),
});
export type BridgeHello = z.infer<typeof BridgeHello>;

export const BridgeBeat = z.strictObject({ type: z.literal('beat') });
export const BridgeHead = z.strictObject({
  type: z.literal('head'),
  id: StreamId,
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string().max(80), z.string().max(2000)),
});
export const BridgeData = z.strictObject({ type: z.literal('data'), id: StreamId, data: z.string().max(Math.ceil((TUNNEL_CHUNK_BYTES * 4) / 3) + 8) });
export const BridgeEnd = z.strictObject({ type: z.literal('end'), id: StreamId });
export const BridgeError = z.strictObject({ type: z.literal('error'), id: StreamId, message: z.string().max(300) });
export const BridgeRotated = z.strictObject({ type: z.literal('rotated') });

/** Every frame the bridge may send. */
export const BridgeToSite = z.discriminatedUnion('type', [BridgeHello, BridgeBeat, BridgeHead, BridgeData, BridgeEnd, BridgeError, BridgeRotated]);
export type BridgeToSite = z.infer<typeof BridgeToSite>;

export const SiteWelcome = z.strictObject({
  type: z.literal('welcome'),
  serverId: BotServerId,
  name: z.string().max(40),
  heartbeatSeconds: z.number().int().min(5).max(60),
});
export const SiteRequest = z.strictObject({
  type: z.literal('request'),
  id: StreamId,
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
  /** Path and query only, starting with `/`. */
  path: z.string().min(1).max(2000).startsWith('/'),
  headers: z.record(z.string().max(80), z.string().max(2000)),
  body: z.string().max(TUNNEL_MAX_REQUEST_BYTES).optional(),
});
export const SiteCancel = z.strictObject({ type: z.literal('cancel'), id: StreamId });
export const SiteRotate = z.strictObject({ type: z.literal('rotate'), key: z.string().regex(BRIDGE_KEY_PATTERN) });
export const SiteBeatAck = z.strictObject({ type: z.literal('beat_ack') });

/** Every frame the site may send. */
export const SiteToBridge = z.discriminatedUnion('type', [SiteWelcome, SiteRequest, SiteCancel, SiteRotate, SiteBeatAck]);
export type SiteToBridge = z.infer<typeof SiteToBridge>;
