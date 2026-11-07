import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { checkSendAt } from '@manythreads/shared';
import { Dialog } from '../components/Dialog';
import { fromLocalInput, presetTime, REMIND_PRESETS, remindWhen, toLocalInput } from '../later/times';
import { useDismiss } from '../shell/useDismiss';
import { ChevronUpIcon } from '../shell/icons';

/*
 * "Send later" on the composer's send button (PLAN P14-05): a small button beside Send opens a menu of times (20 minutes, 1 hour, tomorrow morning,
 * next week) and a way to pick a day and a clock time. The times are worked out here, in the person's own time zone, and sent as exact moments;
 * the presets are the same ones "Remind me" offers (later/times.ts). The same dialog edits a scheduled message (text and time).
 */

/** A sentence for what is wrong with a custom send time, or null when it can be used. */
export function sendTimeError(value: string, now: Date): string | null {
  const at = fromLocalInput(value);
  if (!at) return 'Choose a day and a time.';
  const check = checkSendAt(at, now);
  return check.ok ? null : check.reason;
}

/** The button and its menu. `disabled`: nothing to send (an empty box), so nothing to schedule. `onPick` gets the moment chosen. */
export function SendLaterMenu({ disabled, onPick }: { disabled: boolean; onPick: (at: Date) => void }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const close = (focus = true): void => {
    setOpen(false);
    if (focus) button.current?.focus();
  };
  useDismiss(open, close, wrap);
  useEffect(() => {
    if (open) wrap.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (items.length === 0) return;
    e.preventDefault();
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[to]?.focus();
  };

  const now = new Date();
  return (
    <>
      <span className="sch-wrap" ref={wrap}>
        <button
          ref={button}
          type="button"
          className="icon-btn sch-more"
          aria-label="Send later"
          title="Send later: pick a time"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          data-testid="send-later"
        >
          <ChevronUpIcon />
        </button>
        {open ? (
          <div id={menuId} className="menu menu-up sch-menu" role="menu" aria-label="Send later" onKeyDown={onMenuKey} data-testid="send-later-menu">
            <div className="sch-menu-head" role="presentation">Send this message later</div>
            {REMIND_PRESETS.map((p) => {
              const at = presetTime(p.id, now);
              return (
                <button
                  key={p.id}
                  type="button"
                  role="menuitem"
                  className="menu-item sch-item"
                  data-testid={`send-later-${p.id}`}
                  onClick={() => {
                    close(false);
                    onPick(at);
                  }}
                >
                  <span>{p.label}</span>
                  <small className="sch-when" data-vt-mask>{remindWhen(at.toISOString(), now)}</small>
                </button>
              );
            })}
            <button
              type="button"
              role="menuitem"
              className="menu-item sch-item"
              data-testid="send-later-custom"
              onClick={() => {
                close(false);
                setCustom(true);
              }}
            >
              Pick a date and time…
            </button>
          </div>
        ) : null}
      </span>
      {custom ? (
        <ScheduleDialog
          title="Send later"
          submitLabel="Schedule send"
          initialAt={presetTime('in60', now)}
          onClose={() => {
            setCustom(false);
            button.current?.focus();
          }}
          onSubmit={async ({ at }) => {
            onPick(at);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * A dialog for a send time of the person's own choosing, and, with `initialBody`, for the text too (editing a scheduled message). `onSubmit` may
 * throw: its message is shown in the dialog and the dialog stays open.
 */
export function ScheduleDialog({
  title,
  submitLabel,
  initialAt,
  currentAt,
  initialBody,
  onSubmit,
  onClose,
}: {
  title: string;
  submitLabel: string;
  /** What the time field shows first. */
  initialAt: Date;
  /** The time the message has now (editing): the new time is reported as changed only when the field differs from it. The field has no seconds, so an untouched one is never sent back. */
  currentAt?: Date;
  initialBody?: string;
  onSubmit: (v: { at: Date; body: string; timeChanged: boolean }) => Promise<void>;
  onClose: () => void;
}) {
  const withText = initialBody !== undefined;
  const [value, setValue] = useState(() => toLocalInput(initialAt));
  const [body, setBody] = useState(initialBody ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timeId = useId();
  const bodyId = useId();
  const submit = async (): Promise<void> => {
    if (busy) return;
    if (withText && body.trim() === '') return setError('Write something to send.');
    const problem = sendTimeError(value, new Date());
    if (problem) return setError(problem);
    const at = fromLocalInput(value);
    if (!at) return;
    setBusy(true);
    try {
      await onSubmit({ at, body: body.trim(), timeChanged: currentAt === undefined || value !== toLocalInput(currentAt) });
      onClose();
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error && e.message ? e.message : 'Could not save that. Try again.');
    }
  };
  return (
    <Dialog
      title={title}
      onClose={onClose}
      testId="schedule-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void submit()} data-testid="schedule-save">{busy ? 'Saving…' : submitLabel}</button>
        </>
      }
    >
      {withText ? (
        <>
          <label className="fwd-label" htmlFor={bodyId}>Message</label>
          <textarea
            id={bodyId}
            className="fwd-filter sch-text"
            rows={4}
            value={body}
            maxLength={40_000}
            onChange={(e) => {
              setBody(e.target.value);
              setError(null);
            }}
            data-testid="schedule-body"
          />
        </>
      ) : null}
      <label className="fwd-label" htmlFor={timeId}>Day and time (your time zone)</label>
      <input
        id={timeId}
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
        data-autofocus={withText ? undefined : ''}
        data-testid="schedule-at"
      />
      {error ? <p className="fwd-error" role="alert" data-testid="schedule-error">{error}</p> : null}
    </Dialog>
  );
}
