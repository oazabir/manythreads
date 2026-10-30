import { useEffect, useState, useSyncExternalStore } from 'react';
import { isApiError } from '../api/client';
import { Dialog } from '../components/Dialog';
import { customTimeError, fromLocalInput, presetTime, remindWhen, REMIND_PRESETS, toLocalInput, type RemindPreset } from './times';
import { laterStore } from './store';

/*
 * The "Later" part of a message's More menu (PLAN P14-04): Mark for later, Remind me (20 minutes, 1 hour, tomorrow morning, next week, a time of
 * the person's own choosing) and Remove from Later. The menu entries live here so the message row stays small and only the row whose menu is open
 * listens to the store.
 */

export const useLater = () => useSyncExternalStore(laterStore.subscribe, laterStore.snapshot);

/** A sentence for a refused or failed write: the server's own words when it gave one. */
export function laterErrorText(e: unknown): string {
  if (isApiError(e) && e.status !== 0 && e.status < 500 && e.message) return e.message;
  if (isApiError(e) && e.status === 0 && e.message) return e.message;
  return 'Could not save that. Try again.';
}

type Say = (text: string) => void;

/** The two entries the More menu carries: the save/remove toggle and the way into the reminder choices. */
export function LaterMenuItems({ messageId, onRemind, say, close }: { messageId: string; onRemind: () => void; say: Say; close: () => void }) {
  const later = useLater();
  useEffect(() => {
    void laterStore.load();
  }, []);
  if (!later.supported) return null;
  const saved = laterStore.itemFor(messageId);
  const toggle = async (): Promise<void> => {
    close();
    try {
      if (saved) {
        await laterStore.remove(saved.id);
        say('Removed from Later');
      } else {
        await laterStore.save(messageId);
        say('Saved for later');
      }
    } catch (e) {
      say(laterErrorText(e));
    }
  };
  return (
    <>
      <button type="button" role="menuitem" className="menu-item" data-testid="later-toggle" onClick={() => void toggle()}>{saved ? 'Remove from Later' : 'Mark for later'}</button>
      <button type="button" role="menuitem" className="menu-item" data-testid="later-remind" onClick={onRemind}>{saved?.remindAt ? 'Change reminder…' : 'Remind me…'}</button>
    </>
  );
}

/** Sets a reminder for a message and reports it in words ("Reminder set for Tomorrow at 09:00"). */
export async function remindAt(messageId: string, at: Date, say: Say): Promise<void> {
  try {
    const item = await laterStore.save(messageId, at.toISOString());
    say(`Reminder set for ${remindWhen(item.remindAt ?? at.toISOString())}`);
  } catch (e) {
    say(laterErrorText(e));
  }
}

/** The choices of the "Remind me" menu. `onCustom` opens the dialog for a time of the person's own choosing. */
export function RemindChoices({ messageId, say, close, onCustom }: { messageId: string; say: Say; close: () => void; onCustom: () => void }) {
  const saved = laterStore.itemFor(messageId);
  const pick = (preset: RemindPreset): void => {
    close();
    void remindAt(messageId, presetTime(preset, new Date()), say);
  };
  return (
    <>
      <div className="lt-menu-head" role="presentation">Remind me about this</div>
      {REMIND_PRESETS.map((p) => (
        <button key={p.id} type="button" role="menuitem" className="menu-item" data-testid={`remind-${p.id}`} onClick={() => pick(p.id)}>
          {p.label}
          <small className="lt-when" data-vt-mask>{remindWhen(presetTime(p.id, new Date()).toISOString())}</small>
        </button>
      ))}
      <button type="button" role="menuitem" className="menu-item" data-testid="remind-custom" onClick={onCustom}>Pick a date and time…</button>
      {saved?.remindAt ? (
        <button
          type="button"
          role="menuitem"
          className="menu-item"
          data-testid="remind-clear"
          onClick={() => {
            close();
            void laterStore.save(messageId, null).then(() => say('Reminder cleared'), (e: unknown) => say(laterErrorText(e)));
          }}
        >
          Clear the reminder
        </button>
      ) : null}
    </>
  );
}

/** A dialog for a reminder time of the person's own choosing: a day and a clock time in their zone. */
export function RemindDialog({ messageId, onClose, say }: { messageId: string; onClose: () => void; say: Say }) {
  const [value, setValue] = useState(() => toLocalInput(presetTime('in60', new Date())));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (): Promise<void> => {
    const problem = customTimeError(value, new Date());
    if (problem) return setError(problem);
    const at = fromLocalInput(value);
    if (!at || busy) return;
    setBusy(true);
    try {
      const item = await laterStore.save(messageId, at.toISOString());
      say(`Reminder set for ${remindWhen(item.remindAt ?? at.toISOString())}`);
      onClose();
    } catch (e) {
      setBusy(false);
      setError(laterErrorText(e));
    }
  };
  return (
    <Dialog
      title="Remind me about this"
      onClose={onClose}
      testId="remind-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void submit()} data-testid="remind-save">{busy ? 'Saving…' : 'Set reminder'}</button>
        </>
      }
    >
      <label className="fwd-label" htmlFor="remind-at">Day and time (your time zone)</label>
      <input
        id="remind-at"
        className="fwd-filter"
        type="datetime-local"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void submit();
          }
        }}
        data-autofocus
      />
      {error ? <p className="fwd-error" role="alert" data-testid="remind-error">{error}</p> : null}
    </Dialog>
  );
}
