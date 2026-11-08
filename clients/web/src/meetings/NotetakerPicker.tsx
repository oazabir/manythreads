import { useState } from 'react';
import { Avatar } from '../components/ui';
import type { CallState } from './controller';
import { BotIcon } from './icons';
import { canRemoveNotetaker, notetakerBadge, notetakerReason } from './model';
import { callController } from './store';

/*
 * The note-taker (PLAN P15-18): a team bot that listens to the call on the server and writes the notes. The button opens a small menu: the bots that may be added
 * (anyone in the call may add one) or, when one is in, who it is and a Remove button for the person who started the call or a lead of the team. Adding one asks
 * everybody again whether it may write down their voice. When adding is switched off the menu says why in plain words.
 */

/** The button; nothing is drawn when the server has no note-taker at all. */
export function NotetakerButton({ call, open, onToggle }: { call: CallState; open: boolean; onToggle: () => void }) {
  if (call.notetakers === null) return null;
  const has = call.notetakers.current !== null;
  return (
    <button
      type="button"
      className={`call-btn ${has ? 'live' : ''}`}
      aria-label={has ? 'Note-taker' : 'Add note-taker'}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={has ? 'The note-taker in this call' : 'Add a note-taker'}
      onClick={onToggle}
      data-testid="call-notetaker-btn"
    >
      <BotIcon />
    </button>
  );
}

export function NotetakerMenu({ call, canModerate, onDone }: { call: CallState; canModerate: boolean; onDone: () => void }) {
  const c = callController();
  const res = call.notetakers;
  const [busy, setBusy] = useState<string | null>(null);
  if (!res || !call.meeting) return null;
  const current = res.current;
  const reason = notetakerReason(res);
  const mayRemove = canRemoveNotetaker(call.meeting, call.myActorId, canModerate);
  const run = async (key: string, job: () => Promise<void>): Promise<void> => {
    setBusy(key);
    try {
      await job();
      onDone();
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="call-menu call-notetaker" role="dialog" aria-label="Note-taker" data-testid="call-notetaker">
      {current ? (
        <>
          <div className="nt-row">
            <Avatar name={current.bot.name} kind="agent" avatar={current.bot.avatar} />
            <span className="nt-who">
              <b>{current.bot.name}</b>
              <span className="nt-sub" data-testid="notetaker-badge">{notetakerBadge(current)}</span>
            </span>
          </div>
          <p className="call-hint">It listens to the call on the server and writes the notes. It only writes down people who said yes.</p>
          {mayRemove ? (
            <button type="button" className="btn s call-end-all" disabled={busy !== null} onClick={() => void run('remove', () => c.removeNotetaker())} data-testid="notetaker-remove">Remove note-taker</button>
          ) : (
            <p className="call-hint">Only the person who started the call or a team lead can take it out.</p>
          )}
        </>
      ) : reason ? (
        <>
          <b className="nt-title">Add a note-taker</b>
          <p className="call-hint" data-testid="notetaker-reason">{reason}</p>
        </>
      ) : (
        <>
          <b className="nt-title">Add a note-taker</b>
          <p className="call-hint">A note-taker is a team bot that listens to the call on the server and writes the notes. Everybody is asked again whether it may write down their voice.</p>
          <ul className="nt-list">
            {res.bots.map((b) => (
              <li key={b.botId} className="nt-row" data-testid="notetaker-option">
                <Avatar name={b.name} kind="agent" avatar={b.avatar} />
                <span className="nt-who">
                  <b>{b.name}</b>
                  <span className="nt-sub">{b.role}</span>
                </span>
                <button type="button" className="btn s" disabled={busy !== null} onClick={() => void run(b.botId, () => c.addNotetaker(b.botId))} data-testid={`notetaker-add-${b.slug}`}>
                  Add
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
