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

export function planConsent(state: Pick<MeetingTranscriptionState, 'mode' | 'turnedOnBy'> | null, mine: MeetingConsent, saved: TranscribeDefault): ConsentPlan {
  if (!state || state.mode === 'off') return { kind: 'none' };
  if (mine === 'yes' || mine === 'no') return { kind: 'settled', answer: mine };
  if (saved === 'yes' || saved === 'no') return { kind: 'apply', answer: saved };
  return { kind: 'ask', by: state.turnedOnBy?.displayName ?? null };
}

/** The microphone may open only when nothing is left to ask. */
export const micMayOpen = (plan: ConsentPlan): boolean => plan.kind === 'none' || plan.kind === 'settled';

export type Chip = { label: string; tone: 'on' | 'off' | 'wait'; title: string };

/** The chip beside the call controls; null while transcription is off. */
export function consentChip(state: Pick<MeetingTranscriptionState, 'mode' | 'turnedOnBy'> | null, mine: MeetingConsent): Chip | null {
  if (!state || state.mode === 'off') return null;
  const where = state.mode === 'server' ? 'on the server' : 'on each person’s own device';
  const who = state.turnedOnBy ? `${state.turnedOnBy.displayName} turned on transcription (${where}).` : `Transcription is on (${where}).`;
  if (mine === 'yes') return { label: 'Transcribing', tone: 'on', title: `${who} Your voice is being written down.` };
  if (mine === 'no') return { label: 'Not transcribing you', tone: 'off', title: `${who} You said no: you appear as “spoke (not transcribed)”.` };
  return { label: 'Transcription on', tone: 'wait', title: `${who} Choose whether your voice is written down.` };
}

/** What each person in the roster is shown as, for the one who turned it on to see who said no. */
export function consentWord(c: MeetingConsent): string {
  return c === 'yes' ? 'transcribed' : c === 'no' ? 'not transcribed' : 'not answered yet';
}

/** The words of the prompt: names who turned it on and says exactly what yes and no mean. */
export function promptCopy(by: string | null, mode: 'on_device' | 'server'): { title: string; body: string; yes: string; no: string } {
  const where = mode === 'server' ? 'Your speech is sent to this server to be written down; the sound is not kept.' : 'Your own device writes down what you say; your sound stays on your device.';
  return {
    title: 'Transcribe my voice?',
    body: `${by ?? 'Someone'} turned on transcription for this call. ${where} If you say no, you can still talk: the transcript only shows that you spoke, and when.`,
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
