import type { CallStartOptionsResponse, StartMeetingRequest } from '@manythreads/shared';
import { isApiError } from '../api/client';
import type { ChecklistPerson } from './people';

/*
 * The rules of the start dialog (P15-25) and of the header's call button. Plain functions, no React, so a test can run them.
 */

/** The longest title the dialog takes (the server allows more; a card shows about this much on one line). */
export const START_TITLE_MAX = 120;

/** How long the dialog waits after the last key before it asks the server for the people that match. */
export const FIND_PAUSE_MS = 250;

/** The line under the note-taker switch: nobody's voice is written down without that person's own yes. */
export const CONSENT_LINE = 'Everyone is asked before their voice is written down';

/** In a direct message the dialog lists nobody: everyone in it is rung. */
export const DM_LINE = 'Everyone in this conversation is rung';

/** The words of the header's call button and of its item in the phone's details menu. */
export function callButtonWords(o: { live: boolean; guest: boolean; dm: boolean }): { label: string; title: string; blocked: string | null } {
  if (o.live) return { label: 'Join call', title: 'Join call', blocked: null };
  if (o.guest) return { label: 'Audio call', title: 'Guests cannot start a call here', blocked: 'Guests cannot start a call here' };
  return { label: 'Audio call', title: o.dm ? 'Audio call: ring everyone in this conversation' : 'Audio call: start a call here', blocked: null };
}

/** The people of the options as checklist rows: the caller first, ticked and locked ("Omar (you)"). */
export function checklistPeople(people: CallStartOptionsResponse['people']): ChecklistPerson[] {
  return people.map((p) => (p.you ? { personId: p.personId, displayName: `${p.displayName} (you)`, locked: true } : { personId: p.personId, displayName: p.displayName }));
}

/** The note-taker part of the dialog: whether its switch can be turned on, which bot it names, and why not when it cannot. */
export function notetakerChoice(n: CallStartOptionsResponse['notetaker']): { offered: boolean; defaultBotId: string | null; reason: string | null } {
  if (!n.available) return { offered: false, defaultBotId: null, reason: n.reason ?? 'A note-taker cannot join calls here.' };
  if (n.bots.length === 0) return { offered: false, defaultBotId: null, reason: n.reason ?? 'No bot of this team can take notes.' };
  const first = n.bots.find((b) => b.botId === n.defaultBotId) ?? n.bots[0]!;
  return { offered: true, defaultBotId: first.botId, reason: null };
}

/**
 * The body of the start request. The title is sent only when one is typed (the server writes its own default otherwise); invitees only outside a direct message
 * and never the caller; the note-taker only while its switch is on.
 */
export function buildStartBody(o: {
  title: string;
  picked: readonly string[];
  lockedIds: readonly string[];
  dm: boolean;
  notetakerBotId: string | null;
  kind?: 'audio' | 'video';
  /** Guest links on (P17-04): sent only when the switch is on (never in a direct message). */
  allowGuests?: boolean;
}): StartMeetingRequest {
  const body: StartMeetingRequest = {};
  if (o.allowGuests === true && !o.dm) body.allowGuests = true;
  // a video call (P36-02); an audio call sends no kind, as the older pages did
  if (o.kind === 'video') body.kind = 'video';
  const title = o.title.trim().slice(0, START_TITLE_MAX);
  if (title !== '') body.title = title;
  const invitees = o.dm ? [] : o.picked.filter((id) => !o.lockedIds.includes(id));
  if (invitees.length > 0) body.inviteeIds = invitees as StartMeetingRequest['inviteeIds'];
  if (o.notetakerBotId !== null) body.notetakerBotId = o.notetakerBotId as StartMeetingRequest['notetakerBotId'];
  return body;
}

/** A refused start that was about the note-taker (the server's reasons all name it, transcription or the speech model): the dialog turns the switch off. */
export function isNotetakerRefusal(message: string): boolean {
  return /note-?taker|transcri|speech model|host a note/i.test(message);
}

/** What a refused start or invitation says in the dialog: the server's own sentence for a refusal, fixed words for the rest. */
export function dialogFailure(err: unknown, fallback: string): string {
  // the page's own refusals (a call still connecting) are already in plain words
  if (err instanceof Error && err.name === 'CallBusyError') return err.message;
  if (isApiError(err)) {
    // the page checked the request before sending it: trying again would fail the same way
    if (err.code === 'validation_failed' && err.status === 0) return `This could not be sent: ${err.message}. Change it and press the button again.`;
    if (err.code === 'network') return 'Could not reach the server. Check your connection and try again.';
    if (err.status === 429) return 'Too many tries in a short time. Try again in a minute.';
    if ((err.status === 400 || err.status === 403 || err.status === 404 || err.status === 409) && err.message !== '') return err.message;
  }
  return fallback;
}

/** What the list says when the server could not answer a search: plainly, and that the next key tries again. */
export function searchFailure(err: unknown): string {
  if (isApiError(err) && err.status === 429) return 'Too many searches in a short time. Wait a moment, then type again to retry.';
  if (isApiError(err) && err.code === 'network') return 'Could not reach the server. Type again to retry.';
  return 'The search did not work. Type again to retry.';
}

/** "Invited: Nadia, Rafi +2": the people asked to a call, the first three by name. Null when nobody was asked. */
export function invitedLine(invited: { count: number; names: readonly string[] }): string | null {
  if (invited.count <= 0) return null;
  const names = invited.names.slice(0, 3);
  const more = invited.count - names.length;
  if (names.length === 0) return `Invited: ${invited.count === 1 ? '1 person' : `${invited.count} people`}`;
  return `Invited: ${names.join(', ')}${more > 0 ? ` +${more}` : ''}`;
}
