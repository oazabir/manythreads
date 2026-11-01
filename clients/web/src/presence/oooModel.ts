import { OUT_OF_OFFICE_MESSAGE_MAX, OutOfOfficeInput, localDate, type OutOfOffice, type UpdateMyPresenceRequest } from '@manythreads/shared';

/*
 * The out-of-office form (PLAN P14-01): a switch, the first day back, who to ask meanwhile and a short note. Pure (no network, no DOM), so the screen and
 * the tests agree. The server checks every request again (a return day after today, a delegate who is on the workspace and is not you).
 */

export type OooDraft = { on: boolean; returnsOn: string; delegate: string; message: string };

export const EMPTY_OOO: OooDraft = { on: false, returnsOn: '', delegate: '', message: '' };

/** The form as the saved note fills it in. */
export function oooDraftOf(note: OutOfOffice | null): OooDraft {
  return note ? { on: true, returnsOn: note.returnsOn ?? '', delegate: note.delegatePersonId ?? '', message: note.message } : { ...EMPTY_OOO };
}

export const sameOoo = (a: OooDraft, b: OooDraft): boolean =>
  a.on === b.on && (!a.on || (a.returnsOn === b.returnsOn && a.delegate === b.delegate && a.message.trim() === b.message.trim()));

/** The day after `today` (`2026-06-14` gives `2026-06-15`): the earliest return day the form offers. */
export function dayAfter(today: string): string {
  const [y, m, d] = today.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + 1)).toISOString().slice(0, 10);
}

/** Today's date where the person is: in their saved zone, or UTC when none is saved (the server reads it the same way). */
export const todayFor = (zone: string | null, now: Date): string => localDate(now, zone ?? 'UTC');

export type OooBuilt = { ok: true; body: UpdateMyPresenceRequest } | { ok: false; problem: string };

/** The request that saves the out-of-office note, or the plain sentence that says what to fix. Switched off clears the whole note. */
export function oooRequest(draft: OooDraft, today: string, selfId: string): OooBuilt {
  if (!draft.on) return { ok: true, body: { outOfOffice: null } };
  if (draft.returnsOn !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(draft.returnsOn)) return { ok: false, problem: 'Choose the day you are back.' };
  if (draft.returnsOn !== '' && draft.returnsOn <= today) return { ok: false, problem: 'Choose a return day after today.' };
  if (draft.delegate !== '' && draft.delegate === selfId) return { ok: false, problem: 'You cannot be your own delegate.' };
  if (draft.message.trim().length > OUT_OF_OFFICE_MESSAGE_MAX) return { ok: false, problem: `Keep the note to ${OUT_OF_OFFICE_MESSAGE_MAX} characters.` };
  const parsed = OutOfOfficeInput.safeParse({
    active: true,
    returnsOn: draft.returnsOn === '' ? null : draft.returnsOn,
    delegatePersonId: draft.delegate === '' ? null : draft.delegate,
    message: draft.message,
  });
  if (!parsed.success) return { ok: false, problem: 'That out-of-office note cannot be saved.' };
  return { ok: true, body: { outOfOffice: parsed.data } };
}
