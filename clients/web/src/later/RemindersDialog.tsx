import { useState } from 'react';
import type { Reminder } from '@manythreads/shared';
import { isApiError } from '../api/client';
import { cancelReminder, fetchReminders } from '../api/endpoints';
import { useQuery } from '../app/useQuery';
import { Dialog } from '../components/Dialog';
import { remindWhen } from './times';

/** Who a reminder is for, in words. */
export function reminderFor(r: Pick<Reminder, 'targetKind' | 'person' | 'channel'>): string {
  if (r.targetKind === 'me') return 'You';
  if (r.targetKind === 'channel') return r.channel ? `#${r.channel.name}` : 'A channel you can no longer see';
  return r.person ? r.person.name : 'Someone';
}

/** One line about how a finished reminder ended. */
export function reminderOutcome(r: Pick<Reminder, 'state' | 'refusedReason' | 'sentAt'>): string {
  if (r.state === 'sent') return r.sentAt ? `Sent ${remindWhen(r.sentAt)}` : 'Sent';
  if (r.state === 'cancelled') return 'Cancelled';
  if (r.state === 'refused') return r.refusedReason ?? 'Not sent';
  return '';
}

/**
 * `/remind list`: the reminders this person set. The ones waiting come first, each with a Cancel button; the last 30 days of finished ones
 * follow, with how they ended. Only the person's own reminders are ever listed.
 */
export function RemindersDialog({ onClose }: { onClose: () => void }) {
  const pending = useQuery('reminders:pending', () => fetchReminders('pending'));
  const history = useQuery('reminders:history', () => fetchReminders('history'));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const cancel = async (r: Reminder): Promise<void> => {
    setBusy(r.id);
    setError(null);
    try {
      await cancelReminder(r.id);
      pending.reload();
      history.reload();
    } catch (e) {
      setError(isApiError(e) && e.status === 429 ? 'Too many requests in a short time. Wait a moment and try again.' : 'The reminder could not be cancelled just now. Try again in a moment.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      title="Your reminders"
      onClose={onClose}
      testId="reminders-dialog"
      footer={
        <button type="button" className="btn primary" onClick={onClose} data-autofocus>
          Close
        </button>
      }
    >
      <h3 className="rmd-head">Waiting</h3>
      {pending.status === 'loading' ? <p className="dlg-hint">Loading…</p> : null}
      {pending.status === 'error' ? <p className="dlg-hint" role="alert">Your reminders could not be loaded. Close this and try again.</p> : null}
      {pending.status === 'ok' && pending.data.items.length === 0 ? (
        <p className="dlg-hint" data-testid="reminders-empty">Nothing is waiting. Type /remind me tomorrow at 9 call the bank to set one.</p>
      ) : null}
      {pending.status === 'ok' && pending.data.items.length > 0 ? (
        <ul className="rmd-list" aria-label="Waiting reminders" data-testid="reminders-pending">
          {pending.data.items.map((r) => (
            <li key={r.id} className="rmd-row" data-testid="reminder-row">
              <div className="rmd-main">
                <span className="rmd-text" data-vt-mask>{r.text}</span>
                <small className="rmd-meta" data-vt-mask>
                  {reminderFor(r)} · {remindWhen(r.remindAt)}
                </small>
              </div>
              <button type="button" className="btn s" disabled={busy === r.id} onClick={() => void cancel(r)} data-testid="reminder-cancel" aria-label={`Cancel the reminder: ${r.text}`}>
                Cancel
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="dlg-hint rmd-bad" role="alert">{error}</p> : null}
      {history.status === 'ok' && history.data.items.length > 0 ? (
        <>
          <h3 className="rmd-head">Finished in the last 30 days</h3>
          <ul className="rmd-list" aria-label="Finished reminders" data-testid="reminders-history">
            {history.data.items.map((r) => (
              <li key={r.id} className={`rmd-row rmd-${r.state}`} data-testid="reminder-done">
                <div className="rmd-main">
                  <span className="rmd-text" data-vt-mask>{r.text}</span>
                  <small className="rmd-meta" data-vt-mask>
                    {reminderFor(r)} · {reminderOutcome(r)}
                  </small>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Dialog>
  );
}
