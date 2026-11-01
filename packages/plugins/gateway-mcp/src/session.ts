import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

// The session id a bot's endpoint hands out on `initialize` (MCP's `Mcp-Session-Id` header). It is a signed value that names the bot and nothing
// else, so the server keeps no memory of it: any id that verifies is accepted, and a restart, a deploy or another replica never breaks a client
// that holds one. A client that sends an id the server cannot verify (or one of another bot) is told the session is unknown and starts a new one.
//
//   id = "v1." + base64url(botId) + "." + base64url(HMAC-SHA256(secret, "manythreads/mcp-session/v1\n" + botId))
//
// The secret is derived from MANYTHREADS_KMS_KEY (HKDF, a key of its own) so replicas and restarts agree; without the master key (a development
// server) it is random per process, which only means ids end with the process.

const PREFIX = 'manythreads/mcp-session/v1\n';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function sessionSecretFromEnv(env: Record<string, string | undefined> = process.env, warn: (line: string) => void = () => undefined): Buffer {
  const raw = env['MANYTHREADS_KMS_KEY'];
  if (raw) {
    const master = Buffer.from(raw, 'base64');
    if (master.length === 32) return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'manythreads/mcp-session/v1', 32));
    // a key that is set but not usable would otherwise make every replica sign with its own random secret, and a session id from one would be unknown on another
    warn('gateway-mcp: MANYTHREADS_KMS_KEY is set but is not 32 bytes of base64, so MCP session ids are signed with a key of this process alone; clients will start a new session when a request reaches another replica or after a restart');
  }
  return randomBytes(32);
}

const b64 = (value: Buffer | string): string => Buffer.from(value).toString('base64url');
const mac = (secret: Buffer, botId: string): Buffer => createHmac('sha256', secret).update(PREFIX + botId, 'utf8').digest();

export interface McpSessions {
  /** A session id for `botId`. */
  issue(botId: string): string;
  /** The bot an id names, or null when it is malformed or its signature is wrong. Never throws. */
  verify(id: string): string | null;
}

export function createMcpSessions(secret: Buffer = sessionSecretFromEnv()): McpSessions {
  return {
    issue: (botId) => `v1.${b64(botId)}.${b64(mac(secret, botId))}`,
    verify(id) {
      if (id.length > 200) return null;
      const parts = id.split('.');
      if (parts.length !== 3 || parts[0] !== 'v1') return null;
      const botId = Buffer.from(parts[1]!, 'base64url').toString('utf8');
      if (!UUID.test(botId)) return null;
      const given = Buffer.from(parts[2]!, 'base64url');
      const expected = mac(secret, botId);
      return given.length === expected.length && timingSafeEqual(given, expected) ? botId : null;
    },
  };
}
