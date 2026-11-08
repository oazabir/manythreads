import type { MeetingConsent, MeetingTranscriptionState } from '@manythreads/shared';
import type { TranscribeDefault } from './prefs';

/*
 * "Transcribe my voice" (PLAN P15-05), the plain rules. When transcription is on, everybody in the room sees who turned it on and answers yes or no. A late joiner
 * answers before their microphone opens. A person may keep their answer as a personal default; then the answer is sent for them as they join. The chip stays on
 * screen for the whole call. These functions decide what the page shows; they touch nothing.
 */

export type ConsentPlan =
  /** Transcription is off: nothing to ask. */
  | { kind: 'none' }
  /** Ask now. The microphone stays closed until the person answers. */
  | { kind: 'ask'; by: string | null }
  /** The person's saved default answers for them: send it, then open the microphone. */
  | { kind: 'apply'; answer: 'yes' | 'no' }
  /** Already answered. */
  | { kind: 'settled'; answer: 'yes' | 'no' };

/**
 * `serverSide` is true when the person's words would be written down by the server (the room is set to the server, or a note-taker listens). A saved "yes" was given
 * for the person's own device, where the sound stays put, so it is never sent for them when the server does the writing: they are asked. A saved "no" always holds.
 */
export function planConsent(state: Pick<MeetingTranscriptionState, 'mode' | 'turnedOnBy'> | null, mine: MeetingConsent, saved: TranscribeDefault, serverSide = false): ConsentPlan {
  if (!state || state.mode === 'off') return { kind: 'none' };
  if (mine === 'yes' || mine === 'no') return { kind: 'settled', answer: mine };
  if (saved === 'no' || (saved === 'yes' && !serverSide)) return { kind: 'apply', answer: saved };
  return { kind: 'ask', by: state.turnedOnBy?.displayName ?? null };
}

/** Whether the server (and not the person's own device) would write down their words: the room is set to the server, or a note-taker is in it. */
export const writtenOnServer = (state: Pick<MeetingTranscriptionState, 'mode'> | null, notetaker: boolean): boolean => notetaker || state?.mode === 'server';

/** The microphone may open only when nothing is left to ask. */
export const micMayOpen = (plan: ConsentPlan): boolean => plan.kind === 'none' || plan.kind === 'settled';

export type Chip = { label: string; tone: 'on' | 'off' | 'wait'; title: string };

/** The chip beside the call controls; null while transcription is off. `notetaker` is the name of the note-taker bot while one is in the room. */
export function consentChip(state: Pick<MeetingTranscriptionState, 'mode' | 'turnedOnBy'> | null, mine: MeetingConsent, notetaker: string | null = null): Chip | null {
  if (!state || state.mode === 'off') return null;
  const where = notetaker ? `by the note-taker ${notetaker}, on the server` : state.mode === 'server' ? 'on the server' : 'on each person’s own device';
  const who = state.turnedOnBy ? `${state.turnedOnBy.displayName} turned on transcription (${where}).` : `Transcription is on (${where}).`;
  if (mine === 'yes') return { label: 'Transcribing', tone: 'on', title: `${who} Your voice is being written down.` };
  if (mine === 'no') return { label: 'Not transcribing you', tone: 'off', title: `${who} You said no: you appear as “spoke (not transcribed)”.` };
  return { label: 'Transcription on', tone: 'wait', title: `${who} Choose whether your voice is written down.` };
}

/** What each person in the roster is shown as, for the one who turned it on to see who said no. */
export function consentWord(c: MeetingConsent): string {
  return c === 'yes' ? 'transcribed' : c === 'no' ? 'not transcribed' : 'not answered yet';
}

/**
 * The words of the prompt: names who turned it on and says exactly what yes and no mean. With a note-taker in the room it says who listens, where, and that a yes is
 * what lets it write down this person's words.
 */
export function promptCopy(by: string | null, mode: 'on_device' | 'server', notetaker: string | null = null): { title: string; body: string; yes: string; no: string } {
  const no = 'If you say no, you can still talk: the transcript only shows that you spoke, and when.';
  if (notetaker) {
    return {
      title: 'Let the note-taker write down my voice?',
      body: `${notetaker} is the note-taker in this call. It listens on the server to write the notes, so what you say is sent to this server to be written down; the sound is not kept unless recording is on and you agree. It only writes down people who say yes. ${no}`,
      yes: 'Yes, write down my voice',
      no: 'No, do not write me down',
    };
  }
  const where = mode === 'server' ? 'Your speech is sent to this server to be written down; the sound is not kept.' : 'Your own device writes down what you say; your sound stays on your device.';
  return {
    title: 'Transcribe my voice?',
    body: `${by ?? 'Someone'} turned on transcription for this call. ${where} ${no}`,
    yes: 'Yes, transcribe my voice',
    no: 'No, do not transcribe me',
  };
}

/** Whether to offer "Turn on transcription" at all: not when the workspace or the team forbids it (the server says so in `allowed`). */
export function canTurnOn(state: Pick<MeetingTranscriptionState, 'mode' | 'allowed'> | null): boolean {
  return !!state && state.mode === 'off' && state.allowed.length > 0;
}

/** The mode to turn on: the device when it is allowed, else the server. */
export function modeToTurnOn(state: Pick<MeetingTranscriptionState, 'allowed'>): 'on_device' | 'server' | null {
  return state.allowed.includes('on_device') ? 'on_device' : (state.allowed[0] ?? null);
}

/** Which engine writes this person's words, if any. A note-taker in the room listens on the server itself, so no engine runs on the device then. */
export type EnginePlan = 'none' | 'on_device' | 'server';
export function enginePlan(state: Pick<MeetingTranscriptionState, 'mode'> | null, mine: MeetingConsent | undefined, notetaker: boolean): EnginePlan {
  if (!state || state.mode === 'off' || mine !== 'yes') return 'none';
  if (state.mode === 'on_device') return 'on_device';
  return notetaker ? 'none' : 'server';
}

/** When this device is too slow, the room can move to the server where the workspace and the team allow it. It changes things for everybody, so it is a clear button. */
export function canOfferServer(state: Pick<MeetingTranscriptionState, 'mode' | 'allowed'> | null): boolean {
  return !!state && state.mode === 'on_device' && state.allowed.includes('server');
}

/** The status of this person's engine as the page keeps it. */
export type EngineUi =
  | { kind: 'off' }
  | { kind: 'loading'; fraction: number }
  | { kind: 'listening' }
  | { kind: 'too_slow'; message: string }
  | { kind: 'failed'; message: string };

/** One plain line about the engine for the captions strip; null when there is nothing to say. */
export function engineLine(e: EngineUi): string | null {
  if (e.kind === 'loading') return `Getting the speech model ready… ${Math.round(Math.min(1, Math.max(0, e.fraction)) * 100)}%`;
  if (e.kind === 'too_slow' || e.kind === 'failed') return e.message;
  return null;
}
