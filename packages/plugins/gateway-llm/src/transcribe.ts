import { readFakeAsrText, readWavInfo, type LlmTranscribeRequest, type LlmTranscribeResult, type PluginContext, type PluginTx } from '@manythreads/sdk';
import { MEETING_AUDIO_CHUNK_MAX_BYTES, MEETING_AUDIO_CHUNK_MAX_MS, type LlmAliasName } from '@manythreads/shared';
import { scrubProxyDetail } from './litellm.ts';
import { loadEgress, preflight, recordSpend, type RateHit } from './limits.ts';

// The `transcribe` door of the `llm` provider (PLAN P15-07, P15-19, decision C15): one WAV in, its text out, through the pre-call check, the master key and a spend line
// (purpose `transcribe`). The request and result types are in the SDK (`@manythreads/sdk`, `LlmTranscriber`), because the meetings plugin calls this door and plugins do not
// import each other.
//
// What it does, in order:
//   1. checks the audio is what the door takes (one 16 kHz mono 16-bit WAV, at most 2 MiB and 30 s) and answers `refused` if not; a WAV that is only silence is answered
//      with the empty text and goes nowhere (a small Whisper model invents words for silence, and a silent chunk is not worth a call);
//   2. the `transcribe` alias must be bound to a model (Models page); the pre-call check then runs with the alias's egress: the preset's rule (the air-gapped preset
//      allows only a model inside the deployment, the same rule as `local`), the budgets of the workspace and the team, and the guardrails. The audio carries no text, so
//      the check sees an empty one;
//   3. the proxy's `POST /audio/transcriptions` with the master key (multipart form, as OpenAI's own); then a line in the spend ledger.
// The audio is never stored: the bytes are sent on and dropped. Like the other doors it never throws for an unavailable model.
//
// The stand-in (decision C15, MANYTHREADS_FAKE_ASR=1, refused at start when NODE_ENV=production): no proxy and no bound alias are needed, the text is what follows `FAKEASR:`
// in the WAV's data (empty otherwise), and the check and the spend line still happen, so a test sees the same ledger a real call leaves.

/** The ledger's price of one minute of audio on a model outside the deployment (the rate OpenAI charges for Whisper); a model inside the deployment costs nothing per call. */
export const TRANSCRIBE_USD_PER_MINUTE = 0.006;
/** How long the proxy may take for one chunk (a 30 s chunk on a small CPU model takes a few seconds; a loaded server more). */
const TIMEOUT_MS = 60_000;
/** A chunk is cut at 30 s by its sender; a little slack for the last sample frame. */
const DURATION_SLACK_MS = 250;
/** Samples whose largest swing stays under this (of 32768) are silence. */
const SILENCE_PEAK = 24;
const ALIAS: LlmAliasName = 'transcribe';
const allowRate: RateHit = () => ({ allowed: true, retryAfterMs: 0 });

export interface TranscribeDeps {
  env?: NodeJS.ProcessEnv;
  /** Test seam; the default is the global `fetch`. */
  fetch?: typeof fetch;
}

/** True when the stand-in transcriber is on. */
export const fakeAsrEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => (env['MANYTHREADS_FAKE_ASR'] ?? '').trim() === '1';

/** The stand-in must never be on in production: the plugin refuses to start with it. */
export function assertFakeAsrAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (fakeAsrEnabled(env) && env['NODE_ENV'] === 'production') {
    throw new Error('MANYTHREADS_FAKE_ASR=1 is a test stand-in and is refused when NODE_ENV=production');
  }
}

/** True when the 16-bit samples of a WAV never swing past `SILENCE_PEAK`. Linear in the length; stops at the first loud sample. */
function isSilent(wav: Uint8Array, dataOffset: number, dataBytes: number): boolean {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const end = dataOffset + dataBytes - (dataBytes % 2);
  for (let at = dataOffset; at < end; at += 2) {
    const s = view.getInt16(at, true);
    if (s > SILENCE_PEAK || s < -SILENCE_PEAK) return false;
  }
  return true;
}

/** The language hint as the model takes it (`en-GB` becomes `en`); anything that is not a plain code is left out. */
const hintOf = (lang: string | undefined): string | null => {
  const code = (lang ?? '').trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return /^[a-z]{2,3}$/.test(code) ? code : null;
};

const unavailable = (reason: string): LlmTranscribeResult => ({ outcome: 'unavailable', reason });

export async function transcribe(ctx: PluginContext, tx: PluginTx, request: LlmTranscribeRequest, deps: TranscribeDeps = {}): Promise<LlmTranscribeResult> {
  const env = deps.env ?? process.env;
  const fake = fakeAsrEnabled(env);
  const wav = request.wav;
  if (wav.byteLength > MEETING_AUDIO_CHUNK_MAX_BYTES) return { outcome: 'refused', reason: 'The audio is larger than 2 MB.' };
  const info = readWavInfo(wav);
  if (!info.ok) return { outcome: 'refused', reason: info.reason };
  if (info.durationMs > MEETING_AUDIO_CHUNK_MAX_MS + DURATION_SLACK_MS) return { outcome: 'refused', reason: 'The audio is longer than 30 seconds.' };
  if (info.dataBytes === 0 || isSilent(wav, info.dataOffset, info.dataBytes)) return { outcome: 'text', text: '', lang: null };

  const target = await loadEgress(tx, request.workspaceId, ALIAS);
  if (target === null && !fake) {
    return unavailable('Speech to text is not set up: the transcribe model is not bound in the Models page.');
  }
  const sessionId = `meeting:${request.meetingId}`;
  const decision = await preflight(ctx, tx, allowRate, { workspaceId: request.workspaceId, botId: null, teamId: request.teamId, sessionId, alias: ALIAS, text: '' });
  if (!decision.allowed) return { outcome: 'refused', reason: decision.message ?? 'The workspace\'s model limits or guardrails did not allow the call.' };

  let text: string;
  let model: string | null = null;
  let lang: string | null = hintOf(request.lang);
  if (fake) {
    text = readFakeAsrText(wav);
    model = 'fake-asr';
  } else {
    const base = (env['MANYTHREADS_LITELLM_URL'] ?? '').trim().replace(/\/+$/, '');
    if (!base) return unavailable('No LLM gateway URL is configured.');
    const masterKey = (env['MANYTHREADS_LITELLM_MASTER_KEY'] ?? '').trim();
    const form = new FormData();
    form.set('model', ALIAS);
    form.set('response_format', 'verbose_json');
    form.set('temperature', '0');
    if (lang !== null) form.set('language', lang);
    form.set('file', new Blob([wav.slice()], { type: 'audio/wav' }), 'chunk.wav');
    try {
      const res = await (deps.fetch ?? fetch)(`${base}/audio/transcriptions`, {
        method: 'POST',
        headers: masterKey ? { authorization: `Bearer ${masterKey}` } : {},
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const raw = await res.text();
      if (!res.ok) {
        if (res.status === 429) return unavailable('The speech-to-text model is busy right now. Try again in a moment.');
        return unavailable(`The transcribe model did not answer (${res.status}): ${scrubProxyDetail(raw)}`.slice(0, 400));
      }
      let body: { text?: unknown; language?: unknown } = {};
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        return unavailable('The transcribe model answered with something that is not text.');
      }
      if (typeof body.text !== 'string') return unavailable('The transcribe model answered with no text.');
      text = body.text;
      if (typeof body.language === 'string' && /^[a-z]{2,3}$/.test(body.language)) lang = body.language;
    } catch (err) {
      const aborted = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return unavailable(aborted ? 'The transcribe model took too long to answer.' : `The transcribe model did not answer: ${scrubProxyDetail(err instanceof Error ? err.message : 'the call failed')}`.slice(0, 400));
    }
    model = (await tx.query<{ model: string }>('SELECT model FROM app.llm_aliases WHERE workspace_id = $1 AND alias = $2', [request.workspaceId, ALIAS])).rows[0]?.model ?? null;
  }

  // Priced by the length of the audio, not by tokens (a speech model reports none). A model inside the deployment costs nothing per call.
  await recordSpend(tx, {
    workspaceId: request.workspaceId,
    teamId: request.teamId,
    botId: null,
    sessionId,
    runId: null,
    alias: ALIAS,
    model,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: fake || target?.local ? 0 : Number(((info.durationMs / 60_000) * TRANSCRIBE_USD_PER_MINUTE).toFixed(6)),
    purpose: 'transcribe',
  });
  return { outcome: 'text', text: text.trim(), lang };
}
