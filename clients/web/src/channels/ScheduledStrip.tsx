import { useEffect, useRef, useState } from 'react';
import type { ScheduledMessage } from '@manythreads/shared';
import { remindWhen } from '../later/times';
import { ClockIcon } from '../shell/icons';
import { ScheduleDialog } from './SendLater';
import { ALL_SCHEDULED, scheduledErrorText, scheduledStore, useAgreedEdit, useScheduled } from './scheduled';

/** One line of the text, for the strip: the first non-empty line, clipped. */
export function snippetOf(body: string, max = 140): string {
  const line = body.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * The "N scheduled" strip above the composer (PLAN P14-05): the person's own scheduled messages in this channel, each with Edit and Cancel. The
 * channel's strip lists the replies scheduled into its threads too (marked "In a thread"), so a draft whose thread cannot be opened is still found
 * here; a thread's strip (with `threadRootId`) lists only its own. A message whose time came and could not be posted stays as "Not sent" with the
 * reason, to edit and schedule again or to dismiss (the account-wide "Not sent" list, below, finds it even when the channel is closed to the person).
 * Nothing is drawn while there are none, so a channel looks as it did.
 */
export function ScheduledStrip({ channelId, threadRootId = null }: { channelId: string; threadRootId?: string | null }) {
  const snap = useScheduled(channelId);
  const mine = snap.items.filter((m) => threadRootId === null || m.threadRootId === threadRootId);
  const refused = mine.filter((m) => m.state === 'refused').length;
  const waiting = mine.length - refused;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduledMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const agreedEdit = useAgreedEdit();
  // a message that could not be sent opens the list by itself, so its reason is read
  const seenRefused = useRef(0);
  useEffect(() => {
    if (refused > seenRefused.current) setOpen(true);
    seenRefused.current = refused;
  }, [refused]);

  if (mine.length === 0) return null;

  const cancel = async (m: ScheduledMessage): Promise<void> => {
    setError(null);
    try {
      await scheduledStore.cancel(m);
    } catch (e) {
      setError(scheduledErrorText(e));
    }
  };
  const label = [waiting > 0 ? `${waiting} scheduled` : null, refused > 0 ? `${refused} not sent` : null].filter(Boolean).join(' · ');
  const listId = `sch-list-${channelId}-${threadRootId ?? 'channel'}`;

  return (
    <section className={`sch-strip ${refused > 0 ? 'bad' : ''}`} aria-label="Scheduled messages" data-testid="scheduled-strip">
      <button type="button" className="sch-head" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((o) => !o)} data-testid="scheduled-toggle">
        <ClockIcon />
        <span className="sch-count" data-testid="scheduled-count">{label}</span>
        <span className="sch-hint">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open ? (
        <ul id={listId} className="sch-list">
          {mine.map((m) => (
            <li key={m.id} className={`sch-row ${m.state}`} data-testid="scheduled-row" data-state={m.state}>
              <div className="sch-main">
                {m.state === 'refused' ? (
                  <p className="sch-reason" role="status" data-testid="scheduled-reason">
                    <b>Not sent.</b> {m.refusedReason ?? 'It could not be posted.'}
                  </p>
                ) : (
                  <span className="sch-time" data-vt-mask>{remindWhen(m.sendAt)}</span>
                )}
                {threadRootId === null && m.threadRootId !== null ? <span className="sch-where" data-testid="scheduled-in-thread">In a thread</span> : null}
                <span className="sch-snippet" data-vt-mask>{snippetOf(m.body)}</span>
              </div>
              <div className="sch-acts">
                <button type="button" className="btn s" onClick={() => setEditing(m)} data-testid="scheduled-edit" aria-label={`${m.state === 'refused' ? 'Edit and reschedule' : 'Edit'}: ${snippetOf(m.body, 40)}`}>
                  {m.state === 'refused' ? 'Edit and reschedule' : 'Edit'}
                </button>
                <button type="button" className="btn s" onClick={() => void cancel(m)} data-testid="scheduled-cancel" aria-label={`${m.state === 'refused' ? 'Dismiss' : 'Cancel'}: ${snippetOf(m.body, 40)}`}>
                  {m.state === 'refused' ? 'Dismiss' : 'Cancel'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="sch-error" role="alert">{error}</p> : null}
      {editing ? (
        <ScheduleDialog
          title={editing.state === 'refused' ? 'Edit and reschedule' : 'Edit scheduled message'}
          submitLabel={editing.state === 'refused' ? 'Schedule again' : 'Save'}
          initialAt={Date.parse(editing.sendAt) > Date.now() ? new Date(editing.sendAt) : new Date(Date.now() + 5 * 60_000)}
          currentAt={new Date(editing.sendAt)}
          initialBody={editing.body}
          onClose={() => setEditing(null)}
          onSubmit={({ at, body, timeChanged }) => agreedEdit(editing, timeChanged ? { body, sendAt: at } : { body }, editing.state === 'refused' ? 'Schedule again' : 'Save')}
        />
      ) : null}
    </section>
  );
}

/**
 * "Not sent": every message of the person's that could not be posted, from any channel, drawn at the top of the Later list (nothing while there
 * are none). It needs no open channel, so a draft is never lost because its author lost access to the channel (or the thread cannot be opened):
 * the text can be copied, the draft can be dismissed (which also frees one of the 100 places), or, where the person may post again, edited and
 * scheduled again.
 */
export function NotSentList() {
  const snap = useScheduled(ALL_SCHEDULED);
  const refused = snap.items.filter((m) => m.state === 'refused');
  const [editing, setEditing] = useState<ScheduledMessage | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const agreedEdit = useAgreedEdit();
  if (refused.length === 0) return null;

  const dismiss = async (m: ScheduledMessage): Promise<void> => {
    setNote(null);
    try {
      await scheduledStore.cancel(m);
    } catch (e) {
      setNote(scheduledErrorText(e));
    }
  };
  const copy = async (m: ScheduledMessage): Promise<void> => {
    try {
      await navigator.clipboard.writeText(m.body);
      setNote('Copied the text.');
    } catch {
      setNote('Could not copy. Select the text and copy it by hand.');
    }
  };

  return (
    <section className="sch-strip bad sch-unsent" aria-label="Messages not sent" data-testid="not-sent-list">
      <h3 className="sch-head sch-unsent-head">
        <ClockIcon />
        <span className="sch-count">{refused.length === 1 ? '1 scheduled message was not sent' : `${refused.length} scheduled messages were not sent`}</span>
      </h3>
      <ul className="sch-list">
        {refused.map((m) => (
          <li key={m.id} className="sch-row refused" data-testid="not-sent-row">
            <div className="sch-main">
              <p className="sch-reason" role="status">
                <b>Not sent.</b> {m.refusedReason ?? 'It could not be posted.'}
              </p>
              <span className="sch-snippet" data-vt-mask>{snippetOf(m.body, 200)}</span>
            </div>
            <div className="sch-acts">
              <button type="button" className="btn s" onClick={() => void copy(m)} data-testid="not-sent-copy" aria-label={`Copy the text: ${snippetOf(m.body, 40)}`}>Copy text</button>
              <button type="button" className="btn s" onClick={() => setEditing(m)} data-testid="not-sent-edit" aria-label={`Edit and reschedule: ${snippetOf(m.body, 40)}`}>Edit and reschedule</button>
              <button type="button" className="btn s" onClick={() => void dismiss(m)} data-testid="not-sent-dismiss" aria-label={`Dismiss: ${snippetOf(m.body, 40)}`}>Dismiss</button>
            </div>
          </li>
        ))}
      </ul>
      {note ? <p className="sch-error" role="status">{note}</p> : null}
      {editing ? (
        <ScheduleDialog
          title="Edit and reschedule"
          submitLabel="Schedule again"
          initialAt={new Date(Date.now() + 5 * 60_000)}
          currentAt={new Date(editing.sendAt)}
          initialBody={editing.body}
          onClose={() => setEditing(null)}
          // a refused message's own time has passed: the new time is always sent
          onSubmit={({ at, body }) => agreedEdit(editing, { body, sendAt: at }, 'Schedule again')}
        />
      ) : null}
    </section>
  );
}
