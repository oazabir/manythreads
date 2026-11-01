import { describe, expect, it } from 'vitest';
import { createMcpSessions, sessionSecretFromEnv } from '../src/session.ts';

// The session id of a bot's endpoint: a signed value that names the bot, with no server memory behind it (PLAN P14-22).

const BOT = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000a2';

describe('the MCP session id', () => {
  const sessions = createMcpSessions(Buffer.alloc(32, 7));

  it('verifies to the bot it was issued for, and to nothing else', () => {
    const id = sessions.issue(BOT);
    expect(sessions.verify(id)).toBe(BOT);
    expect(sessions.verify(sessions.issue(OTHER))).toBe(OTHER);
    expect(sessions.verify(id)).not.toBe(OTHER);
  });

  it('is accepted by another instance with the same secret (a restart or another replica) and refused with another secret', () => {
    const id = sessions.issue(BOT);
    expect(createMcpSessions(Buffer.alloc(32, 7)).verify(id)).toBe(BOT);
    expect(createMcpSessions(Buffer.alloc(32, 8)).verify(id)).toBeNull();
  });

  it('rejects a changed signature, a signature carried over from another bot, and shapes that are not an id', () => {
    const id = sessions.issue(BOT);
    const [v, bot, sig] = id.split('.') as [string, string, string];
    expect(sessions.verify(`${v}.${bot}.${sig.slice(0, -2)}AA`)).toBeNull();
    expect(sessions.verify(`${v}.${Buffer.from(OTHER).toString('base64url')}.${sig}`)).toBeNull();
    for (const bad of ['', 'v1', 'v1..', 'v1.a.b', `v2.${bot}.${sig}`, `${id}.extra`, 'x'.repeat(5000), `v1.${Buffer.from('not-a-uuid').toString('base64url')}.${sig}`, '\u0000\u0001']) {
      expect(sessions.verify(bad)).toBeNull();
    }
  });

  it('names the bot and carries no secret: the id decodes to the bot id and a signature, nothing of the key', () => {
    const secret = Buffer.alloc(32, 7);
    const id = createMcpSessions(secret).issue(BOT);
    expect(id).not.toContain(secret.toString('base64url'));
    expect(Buffer.from(id.split('.')[1]!, 'base64url').toString()).toBe(BOT);
  });

  it('derives its key from the master key, a different one from every other use of it, and falls back to a random one without a master key', () => {
    const master = Buffer.alloc(32, 3).toString('base64');
    expect(sessionSecretFromEnv({ MANYTHREADS_KMS_KEY: master }).equals(sessionSecretFromEnv({ MANYTHREADS_KMS_KEY: master }))).toBe(true);
    expect(sessionSecretFromEnv({ MANYTHREADS_KMS_KEY: master }).equals(Buffer.from(master, 'base64'))).toBe(false);
    expect(sessionSecretFromEnv({}).equals(sessionSecretFromEnv({}))).toBe(false);
  });

  it('says so at start-up when the master key is set but unusable (every replica would sign with its own random key), and stays quiet otherwise', () => {
    const lines: string[] = [];
    sessionSecretFromEnv({ MANYTHREADS_KMS_KEY: 'not-32-bytes' }, (l) => void lines.push(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('MANYTHREADS_KMS_KEY');
    sessionSecretFromEnv({}, (l) => void lines.push(l));
    sessionSecretFromEnv({ MANYTHREADS_KMS_KEY: Buffer.alloc(32, 3).toString('base64') }, (l) => void lines.push(l));
    expect(lines).toHaveLength(1);
  });
});
