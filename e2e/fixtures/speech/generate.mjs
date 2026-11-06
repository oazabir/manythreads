// Makes hello.wav: a synthetic, speech-LIKE signal (a voiced buzz shaped by vowel formants, in syllable-sized bursts with pauses). It is NOT
// human speech and no recogniser will find words in it. It exists so the browser tests have a microphone signal that is loud, changes over time
// and has silent gaps (the level meter, the waveform peaks and the speech finder all have something to react to). The words a test sees come
// from the fake engine (clients/web/src/speech/fake.ts), never from this file.
// Run: node e2e/fixtures/speech/generate.mjs   (deterministic: the same bytes every time; nothing is downloaded)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RATE = 16000;
const SECONDS = 6;
const N = RATE * SECONDS;
const VOWELS = [
  [730, 1090], // a
  [270, 2290], // i
  [300, 870], // u
  [530, 1840], // e
  [570, 840], // o
];
// syllables: [start s, length s, vowel, base pitch Hz]
const SYLLABLES = [];
for (let i = 0; i < 12; i += 1) SYLLABLES.push([0.2 + i * 0.42 + (i >= 6 ? 0.5 : 0), 0.3, i % VOWELS.length, 110 + ((i * 17) % 40)]);

const out = new Float64Array(N);
for (const [start, len, v, f0] of SYLLABLES) {
  const [f1, f2] = VOWELS[v];
  const from = Math.floor(start * RATE);
  const to = Math.min(N, Math.floor((start + len) * RATE));
  let phase = 0;
  for (let n = from; n < to; n += 1) {
    const t = (n - from) / (to - from);
    const env = Math.sin(Math.PI * t) ** 1.5; // soft attack and release
    const pitch = f0 * (1 + 0.12 * (0.5 - t)); // falling pitch
    phase += (2 * Math.PI * pitch) / RATE;
    let s = 0;
    for (let h = 1; h * pitch < 4000; h += 1) {
      const f = h * pitch;
      const gain = (1 / h) * (Math.exp(-(((f - f1) / 140) ** 2)) * 1.0 + Math.exp(-(((f - f2) / 220) ** 2)) * 0.6 + 0.04);
      s += gain * Math.sin(h * phase);
    }
    out[n] += env * s;
  }
}
let peak = 0;
for (const x of out) peak = Math.max(peak, Math.abs(x));
const pcm = Buffer.alloc(N * 2);
for (let n = 0; n < N; n += 1) pcm.writeInt16LE(Math.round((out[n] / peak) * 0.6 * 32767), n * 2);
const head = Buffer.alloc(44);
head.write('RIFF', 0);
head.writeUInt32LE(36 + pcm.length, 4);
head.write('WAVEfmt ', 8);
head.writeUInt32LE(16, 16);
head.writeUInt16LE(1, 20);
head.writeUInt16LE(1, 22);
head.writeUInt32LE(RATE, 24);
head.writeUInt32LE(RATE * 2, 28);
head.writeUInt16LE(2, 32);
head.writeUInt16LE(16, 34);
head.write('data', 36);
head.writeUInt32LE(pcm.length, 40);
writeFileSync(fileURLToPath(new URL('./hello.wav', import.meta.url)), Buffer.concat([head, pcm]));
