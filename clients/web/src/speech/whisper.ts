/*
 * Whisper inside the worker (PLAN P14-16): opens the model through Transformers.js (ONNX Runtime Web), finds the language, and turns one window of
 * speech (at most 28 seconds, from vad.ts) into timed text. Everything that is plain arithmetic on tokens and times is a function of its own
 * so the tests cover it; the model library is loaded on demand (`loadLibrary`), never at import, so this file is safe to import anywhere.
 *
 * Why not just call the library's speech pipeline: it does not find the language (it assumes English when none is given), cuts the clip at
 * fixed lengths instead of at pauses, and gives no way to report progress by window. The pieces it is made of are used here directly.
 */
import { MODELS_PATH, ModelProgress, ortPaths, whisperModelId, type DevicePreference, type FileEvent, type SpeechDevice } from './protocol';
import { createSileroRunner, type VadLibrary, type VadRunner } from './vad';
import type { SpeechSegment, WhisperModelName } from './types';

/** The part of the model library this file uses (typed loosely: the library's own types are far wider than what is read). */
export interface TransformersLibrary extends VadLibrary {
  env: {
    allowRemoteModels: boolean;
    allowLocalModels: boolean;
    localModelPath: string;
    useBrowserCache: boolean;
    backends: { onnx: { wasm: { wasmPaths: unknown; numThreads: number; proxy: boolean } } };
  };
  pipeline(task: string, id: string, options: Record<string, unknown>): Promise<AsrPipeline>;
}

/** The speech pipeline's parts that are used here (the library's own types are far wider and, for Whisper, partly missing). */
export interface AsrPipeline {
  model: {
    generation_config?: { lang_to_id?: Record<string, number>; decoder_start_token_id?: number };
    config: { max_source_positions: number };
    forward(inputs: Record<string, unknown>): Promise<{ logits: { data: ArrayLike<number> } }>;
    generate(inputs: Record<string, unknown>): Promise<{ tolist(): bigint[] }[]>;
  };
  processor: {
    (samples: Float32Array): Promise<{ input_features: unknown }>;
    feature_extractor: { config: { chunk_length: number; hop_length: number } };
  };
  tokenizer: {
    _decode_asr(sequences: unknown[], options: Record<string, unknown>): [string, { chunks?: RawChunk[] }];
  };
  dispose?(): Promise<void>;
}

let library: Promise<TransformersLibrary> | null = null;

/** Loads Transformers.js once and points it at our own files: nothing is fetched from anywhere but this site. */
export function loadLibrary(): Promise<TransformersLibrary> {
  library ??= import('@huggingface/transformers').then((lib) => {
    const env = (lib as unknown as TransformersLibrary).env;
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = MODELS_PATH;
    // The service worker (public/sw.js) is the model cache; the library's own copy would hold every file twice.
    env.useBrowserCache = false;
    const wasm = env.backends.onnx.wasm;
    wasm.wasmPaths = ortPaths((globalThis as { location?: { origin: string } }).location?.origin);
    wasm.numThreads = 1;
    wasm.proxy = false;
    return lib as unknown as TransformersLibrary;
  });
  return library;
}

// ---- plain arithmetic ---------------------------------------------------------------------------------------------------------------------

/** One timed run of words as the tokenizer hands it back: seconds from the window's start, the end may be missing for the last one. */
export interface RawChunk {
  text: string;
  timestamp: [number | null, number | null];
}

/** Segments in milliseconds from the start of the whole clip. Empty text is dropped; a missing end becomes the window's end. */
export function segmentsFromChunks(chunks: RawChunk[], windowStartMs: number, windowEndMs: number): SpeechSegment[] {
  const out: SpeechSegment[] = [];
  for (const c of chunks) {
    const text = c.text.trim();
    if (!text) continue;
    const start = Math.round((c.timestamp[0] ?? 0) * 1000) + windowStartMs;
    const rawEnd = c.timestamp[1] === null ? windowEndMs : Math.round(c.timestamp[1] * 1000) + windowStartMs;
    const s = Math.max(windowStartMs, Math.min(start, windowEndMs));
    out.push({ text, startMs: s, endMs: Math.max(s, Math.min(rawEnd, windowEndMs)) });
  }
  return out;
}

/** The language whose token has the highest score; `langIds` maps a token id to its two-letter code ("en"). Null when there are none. */
export function languageFromLogits(logits: ArrayLike<number>, langIds: Map<number, string>): string | null {
  let best: string | null = null;
  let bestScore = -Infinity;
  for (const [id, code] of langIds) {
    const v = logits[id];
    if (v !== undefined && v > bestScore) {
      bestScore = v;
      best = code;
    }
  }
  return best;
}

/** `{"<|en|>": 50259, ...}` from the model's generation settings to `Map(50259 → "en")`. */
export function languageTokenMap(langToId: Record<string, number> | null | undefined): Map<number, string> {
  const m = new Map<number, string>();
  for (const [token, id] of Object.entries(langToId ?? {})) {
    const code = /^<\|([a-z]{2,3})\|>$/.exec(token)?.[1];
    if (code) m.set(id, code);
  }
  return m;
}

/** The language shared by most of the speech, counting each window by its length. */
export function dominantLanguage(found: { language: string | null; ms: number }[]): string | null {
  const weight = new Map<string, number>();
  for (const f of found) if (f.language) weight.set(f.language, (weight.get(f.language) ?? 0) + f.ms);
  let best: string | null = null;
  let most = 0;
  for (const [lang, w] of weight) if (w > most) [best, most] = [lang, w];
  return best;
}

/** True when the browser has a graphics-card adapter ONNX Runtime can use. */
export async function webGpuAvailable(nav: { gpu?: { requestAdapter(): Promise<unknown> } } | undefined = (globalThis as { navigator?: { gpu?: { requestAdapter(): Promise<unknown> } } }).navigator): Promise<boolean> {
  try {
    return !!nav?.gpu && (await nav.gpu.requestAdapter()) != null;
  } catch {
    return false;
  }
}

export async function pickDevice(preference: DevicePreference): Promise<SpeechDevice> {
  if (preference !== 'auto') return preference;
  return (await webGpuAvailable()) ? 'webgpu' : 'wasm';
}

// ---- the model ----------------------------------------------------------------------------------------------------------------------------

export interface WhisperSession {
  lib: TransformersLibrary;
  name: WhisperModelName;
  device: SpeechDevice;
  pipe: AsrPipeline;
  langIds: Map<number, string>;
  startToken: number;
  timePrecision: number;
  vad: VadRunner | null;
}

export async function loadWhisper(name: WhisperModelName, device: SpeechDevice, onFraction: (f: number) => void): Promise<WhisperSession> {
  const lib = await loadLibrary();
  const id = whisperModelId(name);
  const progress = new ModelProgress(id);
  const pipe = await lib.pipeline('automatic-speech-recognition', id, {
    device,
    dtype: 'q8',
    progress_callback: (e: FileEvent) => {
      const f = progress.update(e);
      if (f !== null) onFraction(f);
    },
  });
  const cfg = pipe.model.generation_config ?? {};
  const featureConfig = pipe.processor.feature_extractor.config;
  return {
    lib,
    name,
    device,
    pipe,
    langIds: languageTokenMap(cfg.lang_to_id),
    startToken: cfg.decoder_start_token_id ?? 50258,
    timePrecision: featureConfig.chunk_length / pipe.model.config.max_source_positions,
    vad: null,
  };
}

/** Loads the speech finder next to the model. Null when it cannot be had (the clip is then cut into equal windows). */
export async function loadVad(session: WhisperSession): Promise<VadRunner | null> {
  if (session.vad) return session.vad;
  try {
    session.vad = await createSileroRunner(session.lib);
  } catch {
    session.vad = null;
  }
  return session.vad;
}

export async function disposeWhisper(session: WhisperSession | null): Promise<void> {
  try {
    await session?.pipe?.dispose?.();
  } catch {
    // nothing left to free
  }
}

/**
 * Reads the language from one window: the encoder runs and the decoder takes one step from the start token; the likeliest language token wins.
 * (The library's own pipeline skips this and assumes English. The encoder's work cannot be handed on to the writing step, so it is done twice for
 * the first window: 1.3 s on the small model in the spike.)
 */
export async function detectLanguage(session: WhisperSession, samples: Float32Array): Promise<string | null> {
  const { lib, pipe } = session;
  const features = (await pipe.processor(samples)).input_features;
  const ids = new lib.Tensor('int64', [BigInt(session.startToken)], [1, 1]);
  const out = await pipe.model.forward({ input_features: features, decoder_input_ids: ids });
  return languageFromLogits(out.logits.data as Float32Array, session.langIds);
}

/** One window of speech to timed text. `language` is a two-letter code. */
export async function transcribeWindow(
  session: WhisperSession,
  samples: Float32Array,
  windowStartMs: number,
  language: string,
): Promise<SpeechSegment[]> {
  const { pipe } = session;
  const hop = pipe.processor.feature_extractor.config.hop_length;
  const features = (await pipe.processor(samples)).input_features;
  const data = await pipe.model.generate({
    inputs: features,
    return_timestamps: true,
    language,
    task: 'transcribe',
    num_frames: Math.floor(samples.length / hop),
  });
  const tokens = data[0]!.tolist();
  const seconds = samples.length / 16_000;
  const [, optional] = pipe.tokenizer._decode_asr([{ tokens, stride: [seconds, 0, 0], is_last: true }], {
    time_precision: session.timePrecision,
    return_timestamps: true,
    force_full_sequences: false,
  });
  const chunks = optional.chunks ?? [];
  return segmentsFromChunks(chunks, windowStartMs, windowStartMs + Math.round(seconds * 1000));
}
