import { useEffect, useId, useState } from 'react';
import { votersText, type ChannelMessage, type PollResultsResponse } from '@manythreads/shared';
import { fetchPollResults } from '../api/endpoints';
import { isApiError } from '../api/client';
import { channelStore } from './store';
import { closedByClock, optionPercent, pollFailureText, pollStatus, toggled } from './polls';

/*
 * The poll card in a message row (PLAN P14-07): the question, the options as a group of toggle buttons (`aria-pressed`; a button votes on a click, Enter
 * or Space, never on an arrow key as a radio would), a bar and a count for each option, and a line saying how many people voted. The count of each
 * option is its button's description, and the line of voters is a polite live region. A vote is counted at once and settled with the server's answer; counts that others
 * change arrive by push and move the bars without moving the layout (every number sits in a column of fixed width, every bar in a fixed-height track).
 * Who voted for what is shown only for a named poll, and only when asked; an anonymous poll has no such list at all.
 */

/** `canVote`: the reader can read the channel, it is not archived, and they are a person. `canClose`: the poll's author, a team lead or an admin. */
type Props = { message: ChannelMessage; canClose: boolean; canVote: boolean };

export function PollCard({ message: m, canClose, canVote }: Props) {
  const stored = m.poll;
  // the clock closes a poll on this page at its closing time (the server refuses votes then too); the minute job records it a moment later
  const [now, setNow] = useState(() => Date.now());
  const poll = stored ? closedByClock(stored, new Date(now)) : undefined;
  const closesAt = stored && !stored.closed ? stored.closesAt : null;
  const name = useId();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [who, setWho] = useState<{ open: boolean; data: PollResultsResponse | null; failed: boolean }>({ open: false, data: null, failed: false });
  // the totals as one string: the list of voters is read again when any count moves while it is open
  const signature = poll ? `${poll.voters}:${poll.options.map((o) => o.votes).join(',')}:${poll.closed}` : '';
  const pollId = poll?.id;
  const open = who.open;

  useEffect(() => {
    if (!open || !pollId) return;
    let cancelled = false;
    fetchPollResults(m.channelId, pollId).then(
      (data) => {
        if (!cancelled) setWho((w) => ({ ...w, data, failed: false }));
      },
      () => {
        if (!cancelled) setWho((w) => ({ ...w, failed: true }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, pollId, signature, m.channelId]);

  useEffect(() => {
    if (!closesAt) return;
    // wake at the closing time, and at least once a minute so "closes in 5 minutes" stays true
    const wait = Math.min(Math.max(Date.parse(closesAt) - Date.now(), 0) + 50, 60_000);
    const t = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(t);
  }, [closesAt, now]);

  if (!poll) return null;
  const multiple = poll.multiple;
  const closed = poll.closed;
  const disabled = !canVote || closed || busy;

  const fail = (e: unknown): void => setError(isApiError(e) ? pollFailureText(e.status, e.message) : pollFailureText(undefined, undefined));
  const choose = async (option: number): Promise<void> => {
    if (disabled) return;
    if (!multiple && poll.mine.includes(option)) return;
    setError(null);
    setBusy(true);
    try {
      await channelStore.vote(m.channelId, m.threadRootId, m.id, poll, toggled(poll, option));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const withdraw = async (): Promise<void> => {
    if (disabled) return;
    setError(null);
    setBusy(true);
    try {
      await channelStore.vote(m.channelId, m.threadRootId, m.id, poll, []);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const close = async (): Promise<void> => {
    setConfirmClose(false);
    setError(null);
    setBusy(true);
    try {
      await channelStore.closePoll(m.channelId, m.threadRootId, m.id, poll.id);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const voted = poll.mine.length > 0;
  const hint = pollStatus(poll, new Date(now));
  return (
    <div className={`poll ${closed ? 'closed' : ''}`} data-testid="poll" data-poll-id={poll.id} data-closed={closed ? 'true' : 'false'} data-anonymous={poll.anonymous ? 'true' : 'false'}>
      <fieldset className="poll-set">
        <legend className="poll-q">{poll.question}</legend>
        <ul className="poll-opts">
          {poll.options.map((o, i) => {
            const mine = poll.mine.includes(i);
            const pct = optionPercent(poll, o.votes);
            const id = `${name}-${i}`;
            const textId = `${id}-t`;
            const countsId = `${id}-n`;
            return (
              <li key={i} className={`poll-opt ${mine ? 'mine' : ''}`} data-testid="poll-option" data-votes={o.votes} data-mine={mine ? 'true' : 'false'}>
                <button
                  id={id}
                  type="button"
                  className="poll-lab"
                  aria-pressed={mine}
                  aria-labelledby={textId}
                  aria-describedby={countsId}
                  disabled={!canVote || closed}
                  onClick={() => void choose(i)}
                  data-testid="poll-choice"
                >
                  <span className="poll-bar" aria-hidden="true">
                    <span className="poll-fill" style={{ width: `${pct}%` }} />
                  </span>
                  <span className="poll-mark" aria-hidden="true" />
                  <span className="poll-text" id={textId}>{o.text}</span>
                  <span className="sr-only" id={countsId}>{`${o.votes} ${o.votes === 1 ? 'vote' : 'votes'}, ${pct} percent${mine ? ', your vote' : ''}`}</span>
                  <span className="poll-n" aria-hidden="true" data-vt-mask>
                    <span className="poll-you">Your vote</span>
                    <span className="poll-count">{o.votes}</span>
                    <span className="poll-pct">{`${pct}%`}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </fieldset>
      <p className="poll-meta">
        <span className="poll-voters" role="status" data-testid="poll-voters" data-vt-mask>{votersText(poll.voters)}</span>
        <span className="poll-rules">{hint}</span>
      </p>
      <div className="poll-acts">
        {voted && !closed && canVote ? (
          <button type="button" className="link-btn" onClick={() => void withdraw()} disabled={busy}>Remove my vote</button>
        ) : null}
        {!poll.anonymous && poll.voters > 0 ? (
          <button type="button" className="link-btn" aria-expanded={who.open} onClick={() => setWho((w) => ({ ...w, open: !w.open }))}>
            {who.open ? 'Hide who voted' : 'Show who voted'}
          </button>
        ) : null}
        {canClose && !closed ? (
          confirmClose ? (
            <>
              <button type="button" className="btn s danger" onClick={() => void close()} disabled={busy}>Close the poll now</button>
              <button type="button" className="link-btn quiet" onClick={() => setConfirmClose(false)}>Keep it open</button>
            </>
          ) : (
            <button type="button" className="link-btn" onClick={() => setConfirmClose(true)} disabled={busy}>Close poll</button>
          )
        ) : null}
      </div>
      {closed ? <p className="poll-closed" role="status">{poll.resultMessageId ? 'This poll is closed. The result is posted in the conversation.' : 'This poll is closed.'}</p> : null}
      {error ? <p className="poll-error" role="alert">{error}</p> : null}
      {who.open ? (
        <div className="poll-who" data-testid="poll-who">
          {who.failed && !who.data ? <p className="poll-hint">The list could not be loaded. Try again in a moment.</p> : null}
          {who.data?.voters ? (
            <ul aria-label="Who voted">
              {who.data.voters.map((v) => (
                <li key={v.actorId}>
                  <b>{v.displayName}</b>
                  <span className="poll-who-opts">{v.options.map((i) => poll.options[i]?.text ?? '').filter((t) => t !== '').join(', ')}</span>
                </li>
              ))}
            </ul>
          ) : who.data ? (
            <p className="poll-hint">Nobody can see who voted in this poll.</p>
          ) : !who.failed ? (
            <p className="poll-hint">Loading…</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
