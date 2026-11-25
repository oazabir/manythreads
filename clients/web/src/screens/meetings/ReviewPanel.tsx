import { useEffect, useId, useState } from 'react';
import { MEETING_REVIEW_TEXT_MAX, type MeetingReview } from '@manythreads/shared';
import { isApiError } from '../../api/client';
import { useQuery } from '../../app/useQuery';
import { confirmMeetingReview, fetchMeetingReview } from '../../meetings/api';
import { confirmBody, confirmLabel, confirmedLine, draftOf, draftReady, keptCount, onReviewChanged, sourceWord, type DraftItem } from '../../meetings/review';

/*
 * The end-of-call review on the meeting page (P17-06 step 2). Shown to the people who were in the call once it has ended and something was marked or found: each action
 * item with its words and owner to change and a Remove button, then "Confirm before sending: 3 action items". Nothing leaves the page before Confirm. After it, the
 * confirmed items and who confirmed them. A person who was not in the call sees nothing here (the server answers no review).
 */

/** How often a just-ended call asks whether its review has opened (the push says so too), and for how long. */
const WAIT_POLL_MS = 15_000;
const WAIT_POLL_MAX = 44;

function Editor({ review, onDone }: { review: MeetingReview; onDone: (next: MeetingReview | null, message: string | null) => void }) {
  const [draft, setDraft] = useState<DraftItem[]>(() => draftOf(review));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = useId();
  const kept = keptCount(draft);
  const set = (id: string, next: Partial<DraftItem>): void => setDraft((d) => d.map((x) => (x.id === id ? { ...x, ...next } : x)));
  const confirm = async (): Promise<void> => {
    if (busy || !draftReady(draft)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await confirmMeetingReview(review.meetingId, confirmBody(review, draft));
      onDone(res.review, null);
    } catch (e) {
      // a review that changed or was confirmed by someone else: show the new one, with the reason
      if (isApiError(e) && e.status === 409) onDone(null, e.message);
      else setError(isApiError(e) && e.message ? e.message : 'The action items could not be confirmed. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <ol className="mv-review-list" aria-label="Action items to confirm">
        {draft.map((d, n) => (
          <li key={d.id} className={`mv-review-item ${d.removed ? 'removed' : ''}`} data-testid="review-item" data-removed={d.removed || undefined}>
            <span className="mv-quiet mv-review-source">{sourceWord(d.source)}</span>
            {d.removed ? (
              <p className="mv-review-gone">
                <s>{d.text}</s>
                <button type="button" className="btn s" onClick={() => set(d.id, { removed: false })} data-testid="review-undo">Put back</button>
              </p>
            ) : (
              <div className="mv-review-fields">
                <label className="sr-only" htmlFor={`${ids}-t${n}`}>{`Action item ${n + 1}`}</label>
                <textarea
                  id={`${ids}-t${n}`}
                  className="dlg-input mv-review-text"
                  rows={2}
                  maxLength={MEETING_REVIEW_TEXT_MAX}
                  value={d.text}
                  onChange={(e) => set(d.id, { text: e.target.value })}
                  data-testid="review-text"
                />
                <div className="mv-review-row">
                  <label className="mv-review-owner">
                    <span className="mv-quiet">Owner</span>
                    <select className="dlg-input" value={d.ownerId ?? ''} onChange={(e) => set(d.id, { ownerId: e.target.value === '' ? null : e.target.value })} data-testid="review-owner">
                      <option value="">No owner</option>
                      {review.people.map((p) => (
                        <option key={p.actorId} value={p.actorId}>{p.displayName}</option>
                      ))}
                    </select>
                  </label>
                  <button type="button" className="btn s" onClick={() => set(d.id, { removed: true })} data-testid="review-remove">Remove</button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ol>
      {error ? <p className="mv-bad" role="alert" data-testid="review-error">{error}</p> : null}
      <div className="mv-review-actions">
        <button type="button" className="btn primary" disabled={busy || !draftReady(draft)} onClick={() => void confirm()} data-testid="review-confirm">
          {busy ? 'Confirming…' : confirmLabel(kept)}
        </button>
        <span className="mv-quiet">Only confirmed items go into the notes.</span>
      </div>
    </>
  );
}

export function ReviewPanel({ meetingId, ended }: { meetingId: string; ended: boolean }) {
  const q = useQuery(`meeting-review:${meetingId}`, () => fetchMeetingReview(meetingId));
  const reload = q.reload;
  const [shown, setShown] = useState<MeetingReview | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const review = shown ?? (q.status === 'ok' ? q.data.review : null);
  const waiting = ended && q.status === 'ok' && q.data.review === null;
  const headId = useId();

  // the review opens, changes or is confirmed: the push says so
  useEffect(
    () =>
      onReviewChanged((id) => {
        if (id !== meetingId) return;
        setShown(null);
        reload();
      }),
    [meetingId, reload],
  );
  // a call that just ended: its review opens when the notes are written (ten minutes at most), so look again for a while
  useEffect(() => {
    if (!waiting) return undefined;
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      if (n > WAIT_POLL_MAX) clearInterval(timer);
      else reload();
    }, WAIT_POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, reload]);

  if (!review) return null;
  return (
    <section className="mv-card mv-review" aria-labelledby={headId} data-testid="meeting-review" data-status={review.status}>
      <h2 id={headId} className="mv-sub">{review.status === 'open' ? 'Review the action items' : 'Action items'}</h2>
      {notice ? <p className="mv-note" role="status" data-testid="review-notice">{notice}</p> : null}
      {review.status === 'open' && review.canConfirm ? (
        <>
          <p className="mv-note">
            {review.notesIncluded ? 'From the notes and what was marked in the call.' : 'What was marked in the call.'} Change the words or the owner, remove what is not an action
            item, then confirm. One person confirms for everyone.
          </p>
          <Editor
            key={`${review.openedAt}:${review.items.length}`}
            review={review}
            onDone={(next, message) => {
              setNotice(message);
              if (next) setShown(next);
              else {
                setShown(null);
                reload();
              }
            }}
          />
        </>
      ) : (
        <>
          <p className="mv-note" data-testid="review-confirmed">{confirmedLine(review)}</p>
          {review.items.length > 0 ? (
            <ul className="mv-review-list" aria-label="Confirmed action items">
              {review.items.map((i) => (
                <li key={i.id} className="mv-review-item" data-testid="review-confirmed-item">
                  <span>{i.text}</span>
                  <span className="mv-quiet">{i.ownerName ? ` — ${i.ownerName}` : ' — no owner'}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </section>
  );
}
