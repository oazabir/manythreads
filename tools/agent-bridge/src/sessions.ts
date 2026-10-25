import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A stable UUID for (profile, session id), shaped like a version-5 UUID (sha1 based), so the same thread always lands in the same Claude Code session. */
export function sessionUuid(profile: string, sessionId: string): string {
  const h = createHash('sha1').update(`${profile}\0${sessionId}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** The sessions the bridge has seen, kept in `<state dir>/sessions.json`: a key is `claude:<uuid>` or `codex:<profile>:<session id hash>`. */
export class SessionStore {
  private readonly file: string;
  private data: Record<string, string> = {};

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.file = join(stateDir, 'sessions.json');
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') this.data[k] = v;
      }
    } catch {
      /* no state yet, or unreadable: start empty */
    }
  }

  get(key: string): string | undefined {
    return Object.hasOwn(this.data, key) ? this.data[key] : undefined;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  set(key: string, value: string): void {
    if (this.data[key] === value) return;
    this.data[key] = value;
    this.save();
  }

  delete(key: string): void {
    if (!(key in this.data)) return;
    delete this.data[key];
    this.save();
  }

  private save(): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }
}

/** Runs of one session go one at a time: two processes cannot share one conversation. */
export class KeyedQueue {
  private tails = new Map<string, Promise<void>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}
