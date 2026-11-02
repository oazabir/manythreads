import { Resolver as DnsResolver } from 'node:dns/promises';

// The name lookup of the link-preview fetcher. It must never be able to stall the server.
//
// `dns.lookup` runs on libuv's thread pool (four threads, shared with file reads, crypto and compression). A lookup that waits for a name server that
// never answers holds a thread for many seconds, and the 3 second clock of a fetch cannot cancel it: a few links to a domain with a dead name server
// would freeze every other user of the pool. This resolver talks DNS itself (c-ares, no thread pool) and is bounded in four ways:
//
//   1. one try per question with a short wait (`timeoutMs`), so a dead name server costs one wait, not several;
//   2. at most `maxInFlight` lookups run at once; the others wait their turn (at most `maxWaiting` of them, then a fast refusal), and a waiter whose
//      caller gave up (the abort signal) leaves the line and is never looked up;
//   3. two callers asking for the same name share one lookup;
//   4. a name that failed is not asked again for `negativeTtlMs` (a short negative cache), so a post with the same dead link in ten messages is one wait.
//
// What this resolver does not do is judge an answer: the caller (`safeFetch`) refuses unless every address is public.

export interface DnsBackend {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}

export type Answer = { address: string; family: number };

export interface SystemResolverOptions {
  backend?: DnsBackend;
  /** How long one question waits for an answer. Default 1500 ms. */
  timeoutMs?: number;
  /** Lookups that run at once. Default 2. */
  maxInFlight?: number;
  /** Lookups that may wait for a turn. Default 64. */
  maxWaiting?: number;
  /** How long a failed name is not asked again. Default 30 s. */
  negativeTtlMs?: number;
  /** Failed names remembered at most. Default 1000 (the oldest go first). */
  negativeMax?: number;
  now?: () => number;
}

export interface BoundedResolver {
  (hostname: string, signal?: AbortSignal): Promise<ReadonlyArray<Answer>>;
  /** For tests and the health page: how many lookups run and wait right now. */
  stats(): { inFlight: number; waiting: number; remembered: number };
}

export class LookupRefused extends Error {
  constructor(readonly reason: 'busy' | 'cooling' | 'failed' | 'aborted') {
    super(`name lookup refused: ${reason}`);
    this.name = 'LookupRefused';
  }
}

let backendInstance: DnsBackend | null = null;
const defaultBackend = (timeoutMs: number): DnsBackend => {
  // made on first use, so importing this file opens nothing
  backendInstance ??= new DnsResolver({ timeout: timeoutMs, tries: 1 });
  return backendInstance;
};

export function createBoundedResolver(options: SystemResolverOptions = {}): BoundedResolver {
  const timeoutMs = options.timeoutMs ?? 1500;
  const maxInFlight = options.maxInFlight ?? 2;
  const maxWaiting = options.maxWaiting ?? 64;
  const negativeTtlMs = options.negativeTtlMs ?? 30_000;
  const negativeMax = options.negativeMax ?? 1000;
  const now = options.now ?? Date.now;

  const failed = new Map<string, number>();
  const waiting: Array<{ start: () => void }> = [];
  let inFlight = 0;

  const remember = (name: string): void => {
    failed.delete(name);
    failed.set(name, now() + negativeTtlMs);
    while (failed.size > negativeMax) {
      const oldest = failed.keys().next().value;
      if (oldest === undefined) break;
      failed.delete(oldest);
    }
  };

  const release = (): void => {
    inFlight -= 1;
    const next = waiting.shift();
    if (next) next.start();
  };

  const queryName = async (name: string): Promise<ReadonlyArray<Answer>> => {
    const backend = options.backend ?? defaultBackend(timeoutMs);
    const [v4, v6] = await Promise.allSettled([backend.resolve4(name), backend.resolve6(name)]);
    const answers: Answer[] = [];
    if (v4.status === 'fulfilled') for (const address of v4.value) answers.push({ address, family: 4 });
    if (v6.status === 'fulfilled') for (const address of v6.value) answers.push({ address, family: 6 });
    if (answers.length === 0) throw new LookupRefused('failed');
    return answers;
  };

  const shared = new Map<string, Shared>();

  interface Shared {
    promise: Promise<ReadonlyArray<Answer>>;
    /** Callers still waiting for this lookup. */
    callers: number;
    /** Set while the lookup is waiting for a turn; calling it takes it out of the line and refuses it. */
    drop: (() => void) | null;
  }

  const resolver = ((hostname: string, signal?: AbortSignal): Promise<ReadonlyArray<Answer>> => {
    const name = hostname.toLowerCase();
    const until = failed.get(name);
    if (until !== undefined) {
      if (until > now()) return Promise.reject(new LookupRefused('cooling'));
      failed.delete(name);
    }
    let record = shared.get(name);
    if (!record) {
      const fresh: Shared = { promise: Promise.resolve([]), callers: 0, drop: null };
      fresh.promise = new Promise<ReadonlyArray<Answer>>((resolve, reject) => {
        const run = (): void => {
          fresh.drop = null;
          inFlight += 1;
          queryName(name)
            .then(
              (answers) => resolve(answers),
              (err: unknown) => {
                remember(name);
                reject(err);
              },
            )
            .finally(release);
        };
        if (inFlight < maxInFlight) return run();
        if (waiting.length >= maxWaiting) return reject(new LookupRefused('busy'));
        const entry = { start: run };
        waiting.push(entry);
        fresh.drop = () => {
          const at = waiting.indexOf(entry);
          if (at >= 0) waiting.splice(at, 1);
          reject(new LookupRefused('aborted'));
        };
      });
      const forget = (): void => {
        if (shared.get(name) === fresh) shared.delete(name);
      };
      fresh.promise.then(forget, forget);
      shared.set(name, fresh);
      record = fresh;
    }
    const mine = record;
    mine.callers += 1;
    if (!signal) return mine.promise;
    // this caller gives up when its signal fires; the lookup is dropped only when nobody is left waiting for it and it has not started
    signal.addEventListener(
      'abort',
      () => {
        mine.callers -= 1;
        if (mine.callers <= 0 && mine.drop) mine.drop();
      },
      { once: true },
    );
    return raceSignal(mine.promise, signal);
  }) as BoundedResolver;
  resolver.stats = () => ({ inFlight, waiting: waiting.length, remembered: failed.size });
  return resolver;
}

/** The caller stops waiting when its signal fires; the shared lookup itself carries on for the others. */
function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new LookupRefused('aborted'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** The resolver the fetcher uses unless a test hands it another. */
export const systemResolver: BoundedResolver = createBoundedResolver();
