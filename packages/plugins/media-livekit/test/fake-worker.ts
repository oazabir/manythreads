// A stand-in for listener-worker.ts that speaks the same messages without LiveKit (loaded by Node itself: erasable TypeScript only). The token the listener passes
// picks the behaviour: `echo` posts the url and token it got as the identity of a chunk; `never` never says ready; `crash` dies after ready; `end` says the room ended.
import { parentPort, workerData } from 'node:worker_threads';

const port = parentPort!;
const input = workerData as { url: string; token: string; identities: string[] };
const first = input.token.split('.')[0] ?? '';
const mode = ['plain', 'never', 'crash', 'end', 'speak'].includes(first) ? first : 'echo'; // a real token (a JWT) starts with its header, so it lands on `echo`
const tone = (n: number): Int16Array => Int16Array.from({ length: n }, (_, i) => Math.round(4000 * Math.sin(i / 7)));

if (mode !== 'never') {
  port.postMessage({ type: 'ready' });
  port.postMessage({ type: 'subscriptions', identities: input.identities });
  if (mode === 'echo') {
    const s = tone(1600);
    port.postMessage({ type: 'chunk', identity: JSON.stringify({ url: input.url, token: input.token }), samples: s, startedAtMs: 1_700_000_000_000, durationMs: 100 }, [s.buffer as ArrayBuffer]);
  }
  if (mode === 'speak') {
    const s = tone(16_000);
    port.postMessage({ type: 'chunk', identity: input.identities[0] ?? 'nobody', samples: s, startedAtMs: 1_700_000_000_000, durationMs: 1000 }, [s.buffer as ArrayBuffer]);
  }
  if (mode === 'crash') setTimeout(() => process.exit(1), 30);
  if (mode === 'end') setTimeout(() => port.postMessage({ type: 'closed', reason: 'room_ended' }), 30);
  port.on('message', (m: { type: string; identities?: string[] }) => {
    if (m.type === 'identities') port.postMessage({ type: 'subscriptions', identities: m.identities ?? [] });
    if (m.type === 'close') port.postMessage({ type: 'closed', reason: 'closed' });
  });
}
