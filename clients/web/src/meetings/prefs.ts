/*
 * What a person chose for calls, kept in this browser only (a per-device convenience: the microphone and speakers belong to the device). The personal default for
 * "Transcribe my voice" (PLAN P15-05) is kept the same way: `ask` means "ask me every time".
 */

export type TranscribeDefault = 'ask' | 'yes' | 'no';

export type CallPrefs = {
  inputId: string | null;
  outputId: string | null;
  pushToTalk: boolean;
  captions: boolean;
  sounds: boolean;
  transcribeDefault: TranscribeDefault;
};

export const DEFAULT_PREFS: CallPrefs = { inputId: null, outputId: null, pushToTalk: false, captions: false, sounds: true, transcribeDefault: 'ask' };

export const PREFS_KEY = 'manythreads_call_prefs';

export type KeyValue = { getItem(key: string): string | null; setItem(key: string, value: string): void };

const idOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' && v.length < 500 ? v : null);
const flag = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

/** Reads the saved choices; anything missing or damaged is the default. Never throws (storage can be blocked). */
export function loadPrefs(storage: KeyValue | null): CallPrefs {
  if (!storage) return DEFAULT_PREFS;
  try {
    const raw = storage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const v = JSON.parse(raw) as Record<string, unknown>;
    const td = v['transcribeDefault'];
    return {
      inputId: idOrNull(v['inputId']),
      outputId: idOrNull(v['outputId']),
      pushToTalk: flag(v['pushToTalk'], DEFAULT_PREFS.pushToTalk),
      captions: flag(v['captions'], DEFAULT_PREFS.captions),
      sounds: flag(v['sounds'], DEFAULT_PREFS.sounds),
      transcribeDefault: td === 'yes' || td === 'no' ? td : 'ask',
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(storage: KeyValue | null, prefs: CallPrefs): void {
  if (!storage) return;
  try {
    storage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage can be full or blocked; the choice then lasts for this page only */
  }
}

export function browserStorage(): KeyValue | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
