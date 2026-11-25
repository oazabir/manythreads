import { MEETING_REVIEW_PUSH, MeetingReviewPush, type ConfirmMeetingReviewRequest, type MeetingReview, type MeetingReviewItem } from '@manythreads/shared';

/*
 * The end-of-call review on the meeting page (P17-06 step 2, docs/plans/meeting-assistant.md). The people who were in a call change each action item's words or owner,
 * remove one, and one of them confirms; only confirmed items go into the notes. Nothing is sent until Confirm: the edits live in the page (a draft), and Confirm sends
 * the items kept, with how many the person saw (a review that changed under them is refused, and the page shows the new one).
 */

/** One row of the draft: the item, and whether the person removed it. */
export type DraftItem = { id: string; text: string; ownerId: string | null; removed: boolean; source: MeetingReviewItem['source'] };

export function draftOf(review: MeetingReview): DraftItem[] {
  return review.items.map((i) => ({ id: i.id, text: i.text, ownerId: i.ownerId, removed: false, source: i.source }));
}

/** How many items Confirm sends. */
export const keptCount = (draft: readonly DraftItem[]): number => draft.filter((d) => !d.removed).length;

/** The button: "Confirm before sending: 3 action items" ("…: 1 action item"; "Confirm: no action items" when every one was removed). */
export function confirmLabel(kept: number): string {
  if (kept === 0) return 'Confirm: no action items';
  return `Confirm before sending: ${kept} ${kept === 1 ? 'action item' : 'action items'}`;
}

/** Whether Confirm may be pressed: every kept item has words. */
export const draftReady = (draft: readonly DraftItem[]): boolean => draft.every((d) => d.removed || d.text.trim() !== '');

/** What Confirm sends. */
export function confirmBody(review: MeetingReview, draft: readonly DraftItem[]): ConfirmMeetingReviewRequest {
  return {
    items: draft.filter((d) => !d.removed).map((d) => ({ id: d.id, text: d.text.trim(), ownerId: d.ownerId as ConfirmMeetingReviewRequest['items'][number]['ownerId'] })),
    seen: review.items.length,
  };
}

/** "Where it came from", in a word for each item. */
export const sourceWord = (source: MeetingReviewItem['source']): string => (source === 'mark' ? 'Marked in the call' : 'From the notes');

/** The line under a confirmed review: "Confirmed by Rafi · 2 action items". */
export function confirmedLine(review: Pick<MeetingReview, 'confirmedByName' | 'items'>): string {
  const n = review.items.length;
  return `Confirmed by ${review.confirmedByName ?? 'someone'} · ${n === 0 ? 'no action items' : `${n} ${n === 1 ? 'action item' : 'action items'}`}`;
}

// ---- the push: the review of a meeting opened, changed or was confirmed ------------------------------------------------------------------------------------------

const listeners = new Set<(meetingId: string) => void>();

/** Calls `fn` with the meeting's id whenever its review changes for this person. */
export function onReviewChanged(fn: (meetingId: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The live socket's `meeting.review` push. */
export function handleReviewPush(push: { type: string; payload: unknown }): void {
  if (push.type !== MEETING_REVIEW_PUSH) return;
  const p = MeetingReviewPush.safeParse(push.payload);
  if (!p.success) return;
  for (const l of [...listeners]) l(p.data.meetingId);
}
