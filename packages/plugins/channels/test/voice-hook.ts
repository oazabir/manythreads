import type { LlmClipRequest, LlmClipResult, LlmClipTranscriber } from '@manythreads/sdk';

// The test seam of the voice job (`src/voice.ts`, `voiceHook`): the server runs in this process, so a stand-in for the `llm` provider's clip door is put on
// globalThis under the same symbol. Never honoured in production.
const HOOK = Symbol.for('manythreads.channels.voice.hook');
type Door = Pick<LlmClipTranscriber, 'transcribeClip' | 'clipStatus'>;
const slot = (): { transcriber?: Door } | undefined => (globalThis as unknown as Record<symbol, { transcriber?: Door } | undefined>)[HOOK];

export const installDoor = (door: Door | undefined): void => {
  (globalThis as unknown as Record<symbol, unknown>)[HOOK] = door ? { transcriber: door } : undefined;
};
export const hasDoor = (): boolean => slot()?.transcriber !== undefined;

export interface ScriptedDoor {
  door: Door;
  /** Every clip the job sent, in order. */
  calls: LlmClipRequest[];
  /** Answers still to give (the last one is repeated); a function is called with the request. */
  script: Array<LlmClipResult | ((r: LlmClipRequest) => LlmClipResult | Promise<LlmClipResult>)>;
  /** `clipStatus` answer. */
  status: { ready: true } | { ready: false; reason: string };
}

/** A door that answers from `script` (the last entry again and again once the list is used up). */
export function scriptedDoor(...script: ScriptedDoor['script']): ScriptedDoor {
  const s: ScriptedDoor = {
    calls: [],
    script,
    status: { ready: true },
    door: {
      async transcribeClip(request) {
        s.calls.push(request);
        const next = s.script[Math.min(s.calls.length - 1, s.script.length - 1)]!;
        return typeof next === 'function' ? next(request) : next;
      },
      clipStatus: async () => s.status,
    },
  };
  return s;
}

/** A door that holds every answer until `release()`; for tests that look at a message while it is still `pending`. */
export function heldDoor(result: LlmClipResult = { outcome: 'text', text: 'held words', lang: 'en' }): { door: Door; release: () => void; calls: LlmClipRequest[] } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const calls: LlmClipRequest[] = [];
  return {
    calls,
    release,
    door: {
      async transcribeClip(request) {
        calls.push(request);
        await gate;
        return result;
      },
      clipStatus: async () => ({ ready: true }),
    },
  };
}
