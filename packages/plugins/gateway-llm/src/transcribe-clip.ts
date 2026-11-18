import { VOICE_CLIP_MAX_BYTES, type ClipInTx, type LlmClipRequest, type LlmClipResult, type PluginContext, type PluginTx } from '@manythreads/sdk';
import type { LlmAliasName } from '@manythreads/shared';
import { scrubProxyDetail } from './litellm.ts';
import { loadEgress, loadFallbackChain, preflight, recordSpend, type RateHit } from './limits.ts';
import { fakeAsrEnabled } from './transcribe.ts';

// The clip door of the `llm` provider (P32-03, decision D13): one voice clip as the browser recorded it (WebM, Ogg or MP4) in, its words out, through the
// pre-call check, the master key and a spend line (purpose `transcribe`). The WAV door (`transcribe.ts`, meetings) stays as it is; this one has no WAV
// checks, because the clip is not a WAV and the speech server cuts it at 20 seconds itself (decision D13, section A of the plan).
//
// Three steps, in this order, and the second one holds NO database transaction:
//   1. the check, in one short transaction (`inTx`): the `transcribe` alias must be bound and so must every model on its fallback chain, and every one of them
//      must be a model inside this deployment (the alias's provider is marked local). A model elsewhere is refused here and no byte leaves. Then the pre-call
//      check (the preset, budgets and guardrails; the audio carries no text, so it sees an empty one);
//   2. the proxy's `POST /audio/transcriptions` with the master key, 8 MiB at most, the clip's own content type, 60 seconds at most;
//   3. the spend line, in a second short transaction (cost 0: the model is always local).
// The audio is never stored. The door never throws: a model that is busy or silent is `unavailable` (the caller may try again), anything that will not change
// by waiting is `refused`.
//
// The stand-in (MANYTHREADS_FAKE_ASR=1, refused at start when NODE_ENV=production) answers a fixed sentence after a short delay; no proxy and no bound alias
// are needed, and the check and the spend line still happen.

const ALIAS: LlmAliasName = 'transcribe';
/** How long the proxy may take for one clip (the speech model decodes at most 20 seconds). */
const TIMEOUT_MS = 60_000;
/** The words the stand-in "hears" in every clip. */
export const FAKE_CLIP_TEXT = 'This is a test voice message.';
const FAKE_DELAY_MS = 150;
const allowRate: RateHit = () => ({ allowed: true, retryAfterMs: 0 });

export interface ClipDeps {
  env?: NodeJS.ProcessEnv;
  /** Test seam; the default is the global `fetch`. */
  fetch?: typeof fetch;
  /** Test seam: how long the stand-in waits before it answers. */
  fakeDelayMs?: number;
}

const unavailable = (reason: string): LlmClipResult => ({ outcome: 'unavailable', reason });
const refused = (reason: string): LlmClipResult => ({ outcome: 'refused', reason });

const NOT_SET_UP = 'Speech to text is not set up: the transcribe model is not bound in the Models page.';
const NOT_LOCAL = 'Voice messages are transcribed only by a model inside this deployment, and the transcribe model is not one. Mark its provider as running here, or leave transcripts off.';

/** The extension the proxy needs to tell the container (it guesses the format from the file name as well as the bytes). */
const extensionOf = (contentType: string): string => {
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type.includes('webm')) return 'webm';
  if (type.includes('ogg') || type.includes('opus')) return 'ogg';
  if (type.includes('mp4') || type.includes('m4a') || type.includes('aac')) return 'mp4';
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
  if (type.includes('wav')) return 'wav';
  return 'bin';
};

/** What the first transaction decides: refused with a reason, or the model's name for the spend line. */
type Checked = { ok: true; model: string | null } | { ok: false; reason: string };

/** The alias and every alias its fallbacks reach must be bound to a model inside this deployment. Reads only. */
async function localCheck(tx: PluginTx, workspaceId: string): Promise<{ ok: true; model: string | null } | { ok: false; reason: string }> {
  const target = await loadEgress(tx, workspaceId, ALIAS);
  if (target === null) return { ok: false, reason: NOT_SET_UP };
  if (!target.local) return { ok: false, reason: NOT_LOCAL };
  const remote = (await loadFallbackChain(tx, workspaceId, ALIAS)).find((link) => !(link.egress?.local ?? false));
  if (remote) return { ok: false, reason: NOT_LOCAL };
  const model = (await tx.query<{ model: string }>('SELECT model FROM app.llm_aliases WHERE workspace_id = $1 AND alias = $2', [workspaceId, ALIAS])).rows[0]?.model ?? null;
  return { ok: true, model };
}

export async function clipStatus(tx: PluginTx, workspaceId: string, env: NodeJS.ProcessEnv = process.env): Promise<{ ready: true } | { ready: false; reason: string }> {
  if (fakeAsrEnabled(env)) return { ready: true };
  const checked = await localCheck(tx, workspaceId);
  return checked.ok ? { ready: true } : { ready: false, reason: checked.reason };
}

export async function transcribeClip(ctx: PluginContext, request: LlmClipRequest, inTx: ClipInTx, deps: ClipDeps = {}): Promise<LlmClipResult> {
  const env = deps.env ?? process.env;
  const fake = fakeAsrEnabled(env);
  const clip = request.clip;
  if (clip.byteLength === 0) return refused('The recording is empty.');
  if (clip.byteLength > VOICE_CLIP_MAX_BYTES) return refused('The recording is larger than 8 MB.');
  const sessionId = `voice:${request.messageId}`;

  // 1. the check, in one short transaction
  let checked: Checked;
  try {
    checked = await inTx(async (tx): Promise<Checked> => {
      let model: string | null = null;
      if (fake) {
        model = 'fake-asr';
      } else {
        const local = await localCheck(tx, request.workspaceId);
        if (!local.ok) return local;
        model = local.model;
      }
      const decision = await preflight(ctx, tx, allowRate, { workspaceId: request.workspaceId, botId: null, teamId: request.teamId, sessionId, alias: ALIAS, text: '' });
      if (!decision.allowed) return { ok: false, reason: decision.message ?? "The workspace's model limits or guardrails did not allow the call." };
      return { ok: true, model };
    });
  } catch {
    return unavailable('The check before the speech model could not be made. Try again in a moment.');
  }
  if (!checked.ok) return refused(checked.reason);

  // 2. the model, with no transaction open
  let text: string;
  let lang: string | null = null;
  if (fake) {
    await new Promise((resolve) => setTimeout(resolve, deps.fakeDelayMs ?? FAKE_DELAY_MS));
    text = FAKE_CLIP_TEXT;
    lang = 'en';
  } else {
    const base = (env['MANYTHREADS_LITELLM_URL'] ?? '').trim().replace(/\/+$/, '');
    if (!base) return refused('No LLM gateway URL is configured.');
    const masterKey = (env['MANYTHREADS_LITELLM_MASTER_KEY'] ?? '').trim();
    const form = new FormData();
    form.set('model', ALIAS);
    form.set('response_format', 'verbose_json');
    form.set('file', new Blob([clip.slice()], { type: request.contentType }), `clip.${extensionOf(request.contentType)}`);
    try {
      const res = await (deps.fetch ?? fetch)(`${base}/audio/transcriptions`, {
        method: 'POST',
        headers: masterKey ? { authorization: `Bearer ${masterKey}` } : {},
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const raw = await res.text();
      if (!res.ok) {
        if (res.status === 429) return unavailable('The speech-to-text model is busy right now.');
        const detail = scrubProxyDetail(raw).slice(0, 200);
        // a clip the model cannot read (400, 413, 415, 422) or a key it does not accept will not change by waiting; a server error or a timeout may
        if (res.status >= 400 && res.status < 500 && res.status !== 408) return refused(`The speech model did not accept the recording (${res.status}).`);
        return unavailable(`The speech model did not answer (${res.status}): ${detail}`.slice(0, 400));
      }
      let body: { text?: unknown; language?: unknown } = {};
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        return unavailable('The speech model answered with something that is not text.');
      }
      if (typeof body.text !== 'string') return unavailable('The speech model answered with no text.');
      text = body.text;
      if (typeof body.language === 'string' && /^[a-z]{2,3}$/.test(body.language)) lang = body.language;
    } catch (err) {
      const aborted = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return unavailable(aborted ? 'The speech model took too long to answer.' : `The speech model did not answer: ${scrubProxyDetail(err instanceof Error ? err.message : 'the call failed')}`.slice(0, 400));
    }
  }

  // 3. the spend line, in a second short transaction. Cost 0: the model is inside this deployment. A ledger failure must not throw the words away.
  try {
    await inTx((tx) =>
      recordSpend(tx, {
        workspaceId: request.workspaceId,
        teamId: request.teamId,
        botId: null,
        sessionId,
        runId: null,
        alias: ALIAS,
        model: checked.model,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        purpose: 'transcribe',
      }),
    );
  } catch {
    // the text is what the caller needs; the line is a record
  }
  return { outcome: 'text', text: text.trim(), lang };
}
