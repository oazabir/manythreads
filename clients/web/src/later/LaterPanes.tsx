import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { LaterItem } from '@manythreads/shared';
import { fetchLater } from '../api/endpoints';
import { useQuery } from '../app/useQuery';
import { Avatar } from '../components/ui';
import { ago, clock, dayLabel } from '../channels/format';
import { BackIcon } from '../shell/icons';
import { useOpenMessage } from '../shell/messageLink';
import { laterErrorText, remindAt, RemindDialog } from './RemindMenu';
import { laterStore } from './store';
import { presetTime, remindWhen, REMIND_PRESETS } from './times';

/*
 * The Later tab of the Threads inbox (PLAN P14-04): on the left the person's saved messages (reminders that are due on top), on the right the
 * selected one with the ways to open it, finish it, move its reminder or remove it. The text comes from the server under the person's own
 * access every time, so a deleted message, or one in a channel they can no longer read, is listed as "no longer available" with nothing of it.
 */

export type LaterView = 'open' | 'done';

/** How often the list asks again while it is open: a reminder that falls due moves to the top within this time. */
export const LATER_REFRESH_MS = 30_000;

export const channelLabel = (item: LaterItem): string => {
  const c = item.message?.channel;
  if (!c) return 'Not available';
  return c.kind === 'dm' ? 'Direct message' : c.kind === 'bot_conversation' ? 'Conversation with a bot' : `# ${c.name.replace(/^#/, '')}`;
};

/** The line under a saved message: its reminder, or when it was saved / finished. */
export function whenLine(item: LaterItem, now: Date = new Date()): string {
  if (item.state === 'done' && item.doneAt) return `Done ${dayLabel(item.doneAt, now).toLowerCase()}`;
  if (item.due && item.remindAt) return `Reminder was due ${remindWhen(item.remindAt, now).replace(/^Today at /, 'at ')}`;
  if (item.remindAt) return `Reminder ${remindWhen(item.remindAt, now)}`;
  return `Saved ${dayLabel(item.createdAt, now).toLowerCase()}`;
}

/** The query behind the list, kept fresh while it is on screen. */
export function useLaterList(view: LaterView) {
  const q = useQuery(`later:${view}`, () => fetchLater(view));
  const { reload } = q;
  useEffect(() => {
    const t = setInterval(reload, LATER_REFRESH_MS);
    const onShow = (): void => {
      if (document.visibilityState === 'visible') reload();
    };
    document.addEventListener('visibilitychange', onShow);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onShow);
    };
  }, [reload]);
  return q;
}

export function LaterListBody({
  view,
  setView,
  selected,
  onSelect,
  q,
}: {
  view: LaterView;
  setView: (v: LaterView) => void;
  selected: string | null;
  onSelect: (id: string) => void;
  q: ReturnType<typeof useLaterList>;
}) {
  const items = q.status === 'ok' ? q.data.items : [];
  const dueCount = q.status === 'ok' ? q.data.dueCount : 0;
  return (
    <>
      <div className="lt-views" role="group" aria-label="Show">
        <button type="button" className={`lt-view ${view === 'open' ? 'on' : ''}`} aria-pressed={view === 'open'} onClick={() => setView('open')} data-testid="later-view-open">
          To do{q.status === 'ok' && view === 'open' ? <span data-vt-mask>{` · ${q.data.openCount}`}</span> : null}
        </button>
        <button type="button" className={`lt-view ${view === 'done' ? 'on' : ''}`} aria-pressed={view === 'done'} onClick={() => setView('done')} data-testid="later-view-done">Done</button>
      </div>
      {q.status === 'loading' ? (
        <p className="loading" aria-busy="true">Loading…</p>
      ) : q.status === 'error' ? (
        <div className="inl-empty" role="alert">
          <p className="view-empty-title">Could not load Later.</p>
          <button type="button" className="btn s" onClick={q.reload}>Try again</button>
        </div>
      ) : items.length === 0 ? (
        <div className="inl-empty" data-testid="later-empty">
          <p className="view-empty-title">{view === 'open' ? 'Nothing saved for later' : 'Nothing finished yet'}</p>
          <p className="view-empty-body">{view === 'open' ? 'Open a message’s More menu and choose Mark for later, or Remind me, to find it here.' : 'Items you mark done show up here.'}</p>
        </div>
      ) : (
        <ul className="inlist" role="listbox" aria-label={view === 'open' ? 'Saved for later' : 'Done'}>
          {view === 'open' && dueCount > 0 ? <li className="lt-section" role="presentation" data-testid="later-due-heading">{`Due now · ${dueCount}`}</li> : null}
          {items.map((it, i) => (
            <li key={it.id} role="option" aria-selected={it.id === selected} data-testid="later-row" data-due={it.due} data-available={it.message !== null} data-item-id={it.id}>
              {view === 'open' && dueCount > 0 && i === dueCount ? <div className="lt-section" role="presentation">Later</div> : null}
              <button type="button" className={`trow lt-row ${it.due ? 'due' : ''} ${it.id === selected ? 'on' : ''}`} onClick={() => onSelect(it.id)}>
                <span className="trow-main">
                  <span className="ch">{channelLabel(it)}</span>
                  <span className="ttl lt-ttl" data-vt-mask>{it.message ? `${it.message.authorName}: ${it.message.snippet}` : 'This message is no longer available'}</span>
                  <span className="last" data-vt-mask>{whenLine(it)}</span>
                </span>
                <span className="meta">{it.message ? <span data-vt-mask>{ago(it.message.messageCreatedAt)}</span> : null}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** The selected item on the right: the message, and what can be done with it. */
export function LaterDetail({ item, onChanged, onGone }: { item: LaterItem; onChanged: () => void; onGone: () => void }) {
  const open = useOpenMessage();
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState(false);
  const [opening, setOpening] = useState(false);
  useEffect(() => setNote(null), [item.id]);
  const m = item.message;

  const run = useCallback(
    async (fn: () => Promise<unknown>, after: 'stay' | 'gone' = 'stay'): Promise<void> => {
      if (busy) return;
      setBusy(true);
      setNote(null);
      try {
        await fn();
        onChanged();
        if (after === 'gone') onGone();
      } catch (e) {
        setNote(laterErrorText(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, onChanged, onGone],
  );

  const openIt = async (): Promise<void> => {
    if (!m || opening) return;
    setOpening(true);
    try {
      await open({ channelId: m.channel.id, channelKind: m.channel.kind, channelName: m.channel.kind === 'channel' ? m.channel.name : null, teamId: m.channel.teamId, messageId: item.messageId, threadRootId: m.threadRootId });
    } finally {
      setOpening(false);
    }
  };

  return (
    <section className="lt-detail" aria-label="Saved message" data-testid="later-detail" data-available={m !== null}>
      {m ? (
        <>
          <p className="lt-where">{channelLabel(item)}</p>
          <div className="lt-msg">
            <Avatar name={m.authorName} />
            <div className="lt-msg-main">
              <div className="who">
                <b>{m.authorName}</b>
                <time dateTime={m.messageCreatedAt} data-vt-mask>{`${dayLabel(m.messageCreatedAt)} ${clock(m.messageCreatedAt)}`}</time>
              </div>
              <p className="lt-text" data-vt-mask data-testid="later-detail-text">{m.snippet}</p>
            </div>
          </div>
        </>
      ) : (
        <div className="lt-gone" data-testid="later-gone">
          <p className="view-empty-title">This message is no longer available</p>
          <p className="view-empty-body">It was deleted, or you can no longer read the channel it is in. You can remove it from your list.</p>
        </div>
      )}
      <p className={`lt-when-line ${item.due ? 'due' : ''}`} data-vt-mask>{whenLine(item)}</p>
      <div className="lt-actions">
        {m ? <button type="button" className="btn s primary" disabled={opening} onClick={() => void openIt()} data-testid="later-open">Open message</button> : null}
        {item.state === 'open' ? (
          <button type="button" className="btn s" disabled={busy} onClick={() => void run(() => laterStore.setState(item.id, 'done'), 'gone')} data-testid="later-done">Mark done</button>
        ) : (
          <button type="button" className="btn s" disabled={busy} onClick={() => void run(() => laterStore.setState(item.id, 'open'), 'gone')} data-testid="later-reopen">Move back to To do</button>
        )}
        <button type="button" className="btn s" disabled={busy} onClick={() => void run(() => laterStore.remove(item.id), 'gone')} data-testid="later-remove">Remove</button>
      </div>
      {m && item.state === 'open' ? (
        <div className="lt-snooze" role="group" aria-label="Remind me again">
          <span className="lt-snooze-label">{item.remindAt ? 'Move the reminder' : 'Remind me'}</span>
          {REMIND_PRESETS.map((p) => (
            <button key={p.id} type="button" className="btn s" disabled={busy} data-testid={`later-remind-${p.id}`} onClick={() => void run(() => remindAt(item.messageId, presetTime(p.id, new Date()), setNote).then(() => undefined))}>
              {p.label}
            </button>
          ))}
          <button type="button" className="btn s" disabled={busy} onClick={() => setCustom(true)}>Pick a time…</button>
          {item.remindAt ? (
            <button type="button" className="btn s" disabled={busy} data-testid="later-clear" onClick={() => void run(() => laterStore.save(item.messageId, null))}>Clear the reminder</button>
          ) : null}
        </div>
      ) : null}
      {note ? <p className="lt-note" role="status" data-testid="later-note">{note}</p> : null}
      {custom ? <RemindDialog messageId={item.messageId} say={setNote} onClose={() => { setCustom(false); onChanged(); }} /> : null}
    </section>
  );
}

/**
 * The whole Later tab: the shared tab header, the list, and the selected item. The list is asked for here (not in the inbox above) so nothing is
 * fetched or refreshed while another tab is showing. When the selected item is finished or removed the selection goes with it.
 */
export function LaterTab({
  header,
  narrow,
  view,
  setView,
  selected,
  onSelect,
  bell,
  backLabel,
}: {
  header: ReactNode;
  narrow: boolean;
  view: LaterView;
  setView: (v: LaterView) => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
  bell: ReactNode;
  backLabel: string;
}) {
  const q = useLaterList(view);
  const reload = q.reload;
  const item = q.status === 'ok' ? q.data.items.find((i) => i.id === selected) : undefined;
  const refreshAll = useCallback(() => {
    reload();
    void laterStore.load(true);
  }, [reload]);
  const showList = !narrow || selected === null;
  const showMain = !narrow || selected !== null;
  return (
    <div className={`inbox ${narrow ? 'narrow' : ''}`} data-testid="threads-inbox" data-tab="later">
      {showList ? (
        <div className="inl" data-landmark="thread-list">
          {header}
          <LaterListBody view={view} setView={setView} selected={selected} onSelect={onSelect} q={q} />
        </div>
      ) : null}
      {showMain ? (
        <div className="inr" data-landmark="thread-view">
          {narrow ? (
            <button type="button" className="btn s back-to-list" onClick={() => onSelect(null)}>
              <BackIcon />
              <span>{backLabel}</span>
            </button>
          ) : null}
          {bell}
          {!narrow && !item ? <div className="chead thread-head" /> : null}
          {item ? (
            <LaterDetail key={item.id} item={item} onChanged={refreshAll} onGone={() => onSelect(null)} />
          ) : (
            <div className="inr-empty">
              <p className="view-empty-title">{q.status === 'ok' && q.data.items.length === 0 ? 'Nothing here yet' : 'Pick a saved message'}</p>
              <p className="view-empty-body">Its message, reminder and actions show here.</p>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
