import { useRef, useState } from 'react';
import { clipDurationMs, decodeToSpeechAudio, readDeviceFacts, chooseModel, type DeviceFacts, type WhisperModelName } from '../speech';
import { createWorkerBackend, registerModelCache, spawnWhisperWorker } from '../speech/client';
import type { DevicePreference, SpeechStats } from '../speech/protocol';
import { realTimeFactor, wordErrorRate } from '../speech/wer';

/*
 * Developer page for the speech timings (PLAN P14-16/17): pick a clip (or record one with the file picker of a phone), run Whisper tiny and base on it
 * with the processor (WASM) or the graphics card (WebGPU), and read how long loading and decoding took, the real-time factor, the memory and the word
 * error rate against the words you type. The owner opens it on a phone and on a laptop and pastes the numbers into docs/spikes/speech.md.
 * It is not linked from anywhere; the address is the only way in.
 */

type Row = {
  model: WhisperModelName;
  requested: DevicePreference;
  device: string;
  loadMs: number;
  vadMs: number;
  languageMs: number;
  decodeMs: number;
  wallMs: number;
  audioMs: number;
  rtf: number | null;
  heapMb: number | null;
  language: string | null;
  text: string;
  wer: number | null;
  error?: string;
};

const MODELS: readonly WhisperModelName[] = ['tiny', 'base'];
const DEVICES: readonly DevicePreference[] = ['wasm', 'webgpu'];

const heapMb = (): number | null => {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return m ? Math.round(m.usedJSHeapSize / 1_048_576) : null;
};

const fixed = (n: number | null, digits = 2): string => (n === null ? '–' : n.toFixed(digits));

export function DevSpeech() {
  const [clip, setClip] = useState<{ name: string; blob: Blob } | null>(null);
  const [reference, setReference] = useState('');
  const [facts, setFacts] = useState<DeviceFacts | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [language, setLanguage] = useState('');
  const stop = useRef(false);

  const checkDevice = async (): Promise<void> => setFacts(await readDeviceFacts());

  const runOne = async (blob: Blob, model: WhisperModelName, requested: DevicePreference): Promise<Row> => {
    // a new worker for each run so "load" always includes opening the model, as a first message does
    const backend = createWorkerBackend({ spawn: spawnWhisperWorker, device: requested, onFirstUse: () => registerModelCache() });
    const base = { model, requested, device: '–', loadMs: 0, vadMs: 0, languageMs: 0, decodeMs: 0, wallMs: 0, audioMs: 0, rtf: null, heapMb: null, language: null, text: '', wer: null };
    try {
      const audioMs = await clipDurationMs(blob);
      const pcm = await decodeToSpeechAudio(blob);
      const t0 = performance.now();
      const t = await backend.transcribe(model, pcm, language ? { language } : {});
      const wallMs = performance.now() - t0;
      const s: SpeechStats | null = backend.lastStats();
      return {
        ...base,
        device: s?.device ?? '–',
        loadMs: s?.loadMs ?? 0,
        vadMs: s?.vadMs ?? 0,
        languageMs: s?.languageMs ?? 0,
        decodeMs: s?.decodeMs ?? 0,
        wallMs,
        audioMs,
        // the factor leaves the model loading out: it is the cost of each further clip once the model is in memory
        rtf: realTimeFactor(s ? s.vadMs + s.languageMs + s.decodeMs : wallMs, audioMs),
        heapMb: heapMb(),
        language: t.language,
        text: t.text,
        wer: wordErrorRate(reference, t.text),
      };
    } catch (e) {
      return { ...base, error: e instanceof Error ? e.message : 'Failed' };
    } finally {
      backend.dispose();
    }
  };

  const runAll = async (): Promise<void> => {
    if (!clip || running) return;
    stop.current = false;
    setRows([]);
    for (const model of MODELS) {
      for (const device of DEVICES) {
        if (stop.current) break;
        setRunning(`${model} on ${device === 'wasm' ? 'the processor' : 'the graphics card'}…`);
        const row = await runOne(clip.blob, model, device);
        setRows((r) => [...r, row]);
      }
    }
    setRunning(null);
  };

  const choice = facts ? chooseModel(facts) : null;
  return (
    <div className="dev dev-speech" data-testid="app-frame">
      <h1>Speech bench</h1>
      <p className="lede">Developer page. Runs both Whisper models on a clip, on the processor and on the graphics card, and prints the timings. Nothing is uploaded.</p>
      <section aria-label="Clip">
        <h2>Clip</h2>
        <label className="ds-field">
          <span>Audio file (or record one with your phone)</span>
          <input type="file" accept="audio/*" data-testid="speech-file" onChange={(e) => { const f = e.target.files?.[0]; setClip(f ? { name: f.name, blob: f } : null); setRows([]); }} />
        </label>
        <label className="ds-field">
          <span>What was said (optional, for the word error rate)</span>
          <textarea rows={3} value={reference} onChange={(e) => setReference(e.target.value)} data-testid="speech-reference" />
        </label>
        <label className="ds-field">
          <span>Language code (empty: let the model decide)</span>
          <input type="text" value={language} maxLength={3} onChange={(e) => setLanguage(e.target.value.trim().toLowerCase())} data-testid="speech-language" />
        </label>
        <p className="ds-actions">
          <button type="button" className="btn primary s" onClick={() => void runAll()} disabled={!clip || running !== null} data-testid="speech-run">Run tiny and base</button>
          {running ? <button type="button" className="btn s" onClick={() => { stop.current = true; }}>Stop after this one</button> : null}
          <button type="button" className="btn s" onClick={() => void checkDevice()} data-testid="speech-device">Check this device</button>
        </p>
        <p role="status" aria-live="polite" data-testid="speech-status">{running ?? (clip ? `Ready: ${clip.name}` : 'Choose a clip.')}</p>
      </section>
      {facts ? (
        <section aria-label="This device" data-testid="speech-facts">
          <h2>This device</h2>
          <p>{`WebGPU: ${facts.webgpu ? 'yes' : 'no'} · memory: ${facts.memoryGb === null ? 'not told' : `${facts.memoryGb} GB`} · threads: ${facts.cores} · phone: ${facts.phone ? 'yes' : 'no'}`}</p>
          <p>{choice?.model ? `The app would use the ${choice.model} model here.` : (choice?.reason ?? '')}</p>
        </section>
      ) : null}
      {rows.length > 0 ? (
        <section aria-label="Results" data-testid="speech-results">
          <h2>Results</h2>
          <div className="ds-scroll">
            <table className="ds-table">
              <thead>
                <tr>
                  <th scope="col">Model</th><th scope="col">Asked for</th><th scope="col">Ran on</th><th scope="col">Load ms</th><th scope="col">Speech finder ms</th><th scope="col">Language ms</th>
                  <th scope="col">Decode ms</th><th scope="col">Total ms</th><th scope="col">Clip ms</th><th scope="col">Real-time factor</th><th scope="col">JS heap MB</th><th scope="col">Word error rate</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} data-testid="speech-row">
                    <td>{r.model}</td><td>{r.requested}</td><td>{r.device}</td><td>{Math.round(r.loadMs)}</td><td>{Math.round(r.vadMs)}</td><td>{Math.round(r.languageMs)}</td>
                    <td>{Math.round(r.decodeMs)}</td><td>{Math.round(r.wallMs)}</td><td>{Math.round(r.audioMs)}</td><td>{fixed(r.rtf)}</td><td>{r.heapMb ?? '–'}</td><td>{fixed(r.wer)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.map((r, i) => (
            <p key={i} className="ds-text" data-testid="speech-text">{r.error ? `${r.model} / ${r.requested}: ${r.error}` : `${r.model} / ${r.requested} (${r.language ?? 'language unknown'}): ${r.text || '(no words)'}`}</p>
          ))}
          <pre className="ds-json" data-testid="speech-json">{JSON.stringify(rows.map((r) => ({ ...r, text: undefined })), null, 1)}</pre>
        </section>
      ) : null}
    </div>
  );
}
