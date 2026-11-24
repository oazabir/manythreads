/*
 * What a person chose for calls, kept in this browser only (a per-device convenience: the microphone and speakers belong to the device). The personal default for
 * "Transcribe my voice" (PLAN P15-05) is kept the same way: `ask` means "ask me every time".
 */

export type TranscribeDefault = 'ask' | 'yes' | 'no';
/** How the call's video is laid out (P17-01): equal tiles, or one person large and a strip of the others. */
export type StageLayout = 'grid' | 'speaker';

export type CallPrefs = {
  inputId: string | null;
  outputId: string | null;
  pushToTalk: boolean;
  captions: boolean;
  sounds: boolean;
  transcribeDefault: TranscribeDefault;
  /** The video layout the person picked (P17-01); null until they pick one: then a phone shows Speaker and a wider screen Grid. */
  layout: StageLayout | null;
  /** Put the call's video into a small floating window when the tab is left (P17-01). */
  pip: boolean;
};

export const DEFAULT_PREFS: CallPrefs = { inputId: null, outputId: null, pushToTalk: false, captions: false, sounds: true, transcribeDefault: 'ask', layout: null, pip: true };

export const PREFS_KEY = 'manythreads_call_prefs';

/** Where the layout and picture-in-picture choices were kept before they joined the call prefs (an early P17-01 build); read once, then removed. */
export const OLD_STAGE_KEY = 'manythreads_call_stage';

export type KeyValue = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem?(key: string): void };

const idOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' && v.length < 500 ? v : null);
const flag = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const layoutOrNull = (v: unknown): StageLayout | null => (v === 'grid' || v === 'speaker' ? v : null);

/** The stage choices of the early build's own key, moved into the call prefs once and the old key removed. Never throws. */
function migrateStage(storage: KeyValue, prefs: CallPrefs): CallPrefs {
  try {
    const raw = storage.getItem(OLD_STAGE_KEY);
    if (raw === null) return prefs;
    let next = prefs;
    try {
      const v = JSON.parse(raw) as Record<string, unknown>;
      next = { ...prefs, layout: prefs.layout ?? layoutOrNull(v['layout']), pip: typeof v['pip'] === 'boolean' ? v['pip'] : prefs.pip };
    } catch {
      /* a damaged old value: nothing to keep */
    }
    storage.setItem(PREFS_KEY, JSON.stringify(next));
    storage.removeItem?.(OLD_STAGE_KEY);
    return next;
  } catch {
    return prefs;
  }
}

/** Reads the saved choices; anything missing or damaged is the default. Never throws (storage can be blocked). */
export function loadPrefs(storage: KeyValue | null): CallPrefs {
  if (!storage) return DEFAULT_PREFS;
  return migrateStage(storage, readPrefs(storage));
}

function readPrefs(storage: KeyValue): CallPrefs {
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
      layout: layoutOrNull(v['layout']),
      pip: flag(v['pip'], DEFAULT_PREFS.pip),
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
