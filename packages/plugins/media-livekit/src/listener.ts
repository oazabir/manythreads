import { Worker } from 'node:worker_threads';
import { encodeWav16kMono, type MediaListener, type MediaListenOptions } from '@manythreads/sdk';

// The server side of the note-taker's listener (PLAN P15-19, decision C13): starts one worker thread per room (listener-worker.ts holds the LiveKit library) and
// turns its messages into the `MediaListener` the meetings plugin uses. The worker is told only the address, a hidden subscribe-only token and the people to hear;
// it gets no API key or secret. If it dies, `onClosed('error')` says so and the plugin decides whether to start another.

const WORKER_URL = new URL('./listener-worker.ts', import.meta.url);

export interface StartLivekitListenerInput {
  /** Where the worker connects (`wss://…` or `ws://…`). */
  url: string;
  /** A hidden, subscribe-only token for the room (made by the provider). */
  token: string;
  options: MediaListenOptions;
  /** Test hook: another worker file that speaks the same messages. */
  workerUrl?: URL;
  /** How long to wait for the worker to join before giving up. */
  connectTimeoutMs?: number;
  /** How long `close()` waits for the worker to leave politely. */
  closeTimeoutMs?: number;
}

type FromWorker =
  | { type: 'ready' }
  | { type: 'subscriptions'; identities: string[] }
  | { type: 'chunk'; identity: string; samples: Int16Array; startedAtMs: number; durationMs: number }
  | { type: 'closed'; reason: 'closed' | 'room_ended' | 'error'; message?: string };

export class ListenerStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ListenerStartError';
  }
}

export async function startLivekitListener(input: StartLivekitListenerInput): Promise<MediaListener> {
  const { options } = input;
  const worker = new Worker(input.workerUrl ?? WORKER_URL, {
    workerData: { url: input.url, token: input.token, identities: [...options.identities] },
    // The library is native code: cap what the thread may hold, and give it a small environment of its own (it needs no key of ours).
    resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    env: { NODE_ENV: process.env['NODE_ENV'] ?? 'production' },
  });
  // a listener alone never keeps the server process alive
  worker.unref();
  let subscribed: string[] = [];
  let ended = false;
  // `onClosed` is for a listener that exists; a worker that fails before joining is reported by the rejected promise instead
  let started = false;
  let ready: () => void = () => undefined;
  let failed: (e: Error) => void = () => undefined;
  const joined = new Promise<void>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  joined.catch(() => undefined);

  const timer = setTimeout(() => {
    failed(new ListenerStartError('The note-taker could not join the room in time.'));
    end('error');
  }, input.connectTimeoutMs ?? 15_000);

  const end = (reason: 'closed' | 'room_ended' | 'error'): void => {
    if (ended) return;
    ended = true;
    subscribed = [];
    clearTimeout(timer);
    failed(new ListenerStartError('The note-taker could not join the room.'));
    void worker.terminate();
    if (started) options.onClosed(reason);
  };

  worker.on('message', (m: FromWorker) => {
    if (m.type === 'ready') ready();
    else if (m.type === 'subscriptions') subscribed = [...m.identities];
    else if (m.type === 'chunk') {
      if (ended) return;
      const wav = encodeWav16kMono(m.samples);
      options.onChunk({ identity: m.identity, wav, startedAt: new Date(m.startedAtMs), durationMs: m.durationMs, backlogMs: 0 });
    } else if (m.type === 'closed') end(m.reason);
  });
  worker.on('error', () => end('error'));
  worker.on('exit', () => end('error'));

  await joined;
  clearTimeout(timer);
  started = true;

  return {
    setIdentities(identities) {
      if (ended) return;
      const keep = new Set(identities);
      // a person who left the list loses their track here at once, before the worker has answered
      subscribed = subscribed.filter((id) => keep.has(id));
      worker.postMessage({ type: 'identities', identities: [...identities] });
    },
    subscriptions: () => [...subscribed],
    async close() {
      if (ended) return;
      worker.postMessage({ type: 'close' });
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, input.closeTimeoutMs ?? 3_000);
        worker.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
        worker.once('message', (m: FromWorker) => {
          if (m.type === 'closed') {
            clearTimeout(t);
            resolve();
          }
        });
      });
      end('closed');
    },
  };
}
