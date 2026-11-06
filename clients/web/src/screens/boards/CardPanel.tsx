import { useEffect, useState } from 'react';
import type { Board, BoardColumn, BotSummary, RosterMember, Task, TaskEvent } from '@manythreads/shared';
import { useQuery } from '../../app/useQuery';
import { Markdown } from '../../channels/MessageMarkdown';
import { Alert, Time } from '../../components/ui';
import { STATE_LABEL, dropTargets, eventLine, ownerLabel, refusalText } from './board';
import { BotActivity } from './BotActivity';
import type { CardBot } from './activity';
import { claimTask, completeTask, fetchTask, fetchTaskEvents, handoffTask, releaseTask, reworkTask, tickTask } from './api';
import { taskItemAt } from '../../channels/markdown';

/*
 * One card (SPEC §6.5, PLAN P6-07): the facts the substrate keeps — owner, branch, the two shas, the blocker, the two bounds — its
 * history, and the actions a person takes on it. Every action is one of the card routes, so the rules that hold a bot hold this panel
 * too: a reach for something the task may not do is the server's 409 with its reason, shown here unchanged.
 */

type Props = {
  slug: string;
  task: Task;
  board: Board;
  roster: RosterMember[];
  bots: BotSummary[];
  /** Bumped when anything on the board changed, so the history is re-read with the card. */
  revision: number;
  /** The board's own move, so the drag and the select take the identical path. */
  onMove: (task: Task, to: BoardColumn) => Promise<void>;
  /** The bots working on this card now, and the column the card sits in. */
  botsAtWork: readonly CardBot[];
  placeId: string | undefined;
  /** Tell the board this card (and the columns) changed. */
  onChanged: () => void;
  /** Re-read the board's cards without remounting this panel (a tick keeps its place and its message). */
  onRefresh: () => void;
};

const SHA_RE = /^[0-9a-f]{7,64}$/;

export function CardPanel({ slug, task, board, roster, bots, botsAtWork, placeId, revision, onMove, onChanged, onRefresh }: Props) {
  const [ticks, setTicks] = useState(0);
  const eventsQ = useQuery(`task-events:${slug}:${task.id}:${revision}:${ticks}`, () => fetchTaskEvents(slug, task.id));
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [filed, setFiled] = useState<string | null>(null);
  const [testedSha, setTestedSha] = useState(task.testedSha ?? '');
  const [note, setNote] = useState('');
  const [botSlug, setBotSlug] = useState(bots[0]?.slug ?? '');
  const [strict, setStrict] = useState(false);
  const [to, setTo] = useState<string>(dropTargets(task, board, placeId)[0]?.id ?? '');
  // The description as the server last said it: a tick shows at once, from the server's answer, and a refused tick brings the card back as it is.
  const [description, setDescription] = useState(task.description);
  const [ticking, setTicking] = useState(false);
  // The card the board last read can move on (a bot rewrote the list): the panel follows it, without being made again.
  useEffect(() => setDescription(task.description), [task.description]);

  const nameOf = (id: string | null): string => ownerLabel(id, roster, bots);
  const targets = dropTargets(task, board, placeId);
  const events: TaskEvent[] = eventsQ.status === 'ok' ? eventsQ.data.items : [];

  const run = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(label);
    setProblem(null);
    setFiled(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setProblem(refusalText(err));
    } finally {
      setBusy(null);
    }
  };

  // A box of the description checklist. The server changes that one character and writes a line in the card's history; the box's text travels with the
  // tick so a list a bot rewrote meanwhile never ticks another line.
  const tick = async (nth: number, checked: boolean): Promise<void> => {
    const box = taskItemAt(description, nth);
    if (box === null || ticking) return;
    setTicking(true);
    setProblem(null);
    try {
      const res = await tickTask(slug, task.id, { nth, checked, text: box.text });
      setDescription(res.task.description);
      setTicks((n) => n + 1);
      onRefresh();
    } catch (err) {
      // say why, then show the list as it is now; the message stays (the panel is not made again)
      setProblem(refusalText(err));
      await fetchTask(slug, task.id).then((r) => setDescription(r.task.description), () => undefined);
      setTicks((n) => n + 1);
      onRefresh();
    } finally {
      setTicking(false);
    }
  };

  const complete = (): Promise<void> =>
    run('complete', async () => {
      const sha = testedSha.trim();
      if (sha !== '' && !SHA_RE.test(sha)) {
        setProblem('The tested commit is a lowercase sha of 7 to 64 characters (or leave it empty for a card that has no commit).');
        return;
      }
      await completeTask(slug, task.id, { summary: note.trim(), ...(sha === '' ? {} : { testedSha: sha }) });
    });

  const handoff = (): Promise<void> =>
    run('handoff', async () => {
      const res = await handoffTask(slug, task.id, {
        toBotSlug: botSlug,
        mode: 'bot',
        note: note.trim(),
        strict,
      });
      if (res.pendingApproval) setFiled('Filed. The card moves when an approval is given — it is waiting in the Approvals inbox.');
    });

  return (
    <aside className="bd-panel" data-testid="card-panel" data-card={task.id} data-state={task.state}>
      <div className="bd-panel-head">
        <span className={`bd-kind ${task.kind}`}>{task.kind}</span>
        <span className={`bd-prio ${task.priority}`}>{task.priority}</span>
        <span className="bd-state-pill">{STATE_LABEL[task.state]}</span>
        <BotActivity bots={botsAtWork} roster={bots} className="bd-panel-bot" />
      </div>
      <h3 className="bd-panel-title" data-testid="card-title">{task.title}</h3>
      {description ? (
        <div className="bd-panel-body" data-testid="card-description">
          <Markdown source={description} teamSlug={slug} busy={ticking} {...(task.state === 'done' ? {} : { toggle: (nth: number, checked: boolean) => void tick(nth, checked) })} />
        </div>
      ) : null}

      <dl className="bd-facts">
        <dt>Owner</dt>
        <dd data-testid="card-owner">{nameOf(task.ownerId)}</dd>
        <dt>Branch</dt>
        <dd className="mono">{task.branch}</dd>
        <dt>Base commit</dt>
        <dd className="mono">{task.baseSha ?? '—'}</dd>
        <dt>Tested commit</dt>
        <dd className="mono">{task.testedSha ?? '—'}</dd>
        {task.pullRequest ? (
          <>
            <dt>Pull request</dt>
            <dd data-testid="card-pull-request">
              {/^https:\/\//.test(task.pullRequest.url) ? (
                <a href={task.pullRequest.url} target="_blank" rel="noopener noreferrer">#{task.pullRequest.number}</a>
              ) : (
                <>#{task.pullRequest.number}</>
              )}{' '}
              {task.pullRequest.state === 'open' ? 'waits for a person to merge it' : task.pullRequest.state === 'merged' ? 'merged' : 'closed without a merge'}
            </dd>
          </>
        ) : null}
        <dt>Bounds</dt>
        <dd>
          {task.reworkCount} rework{task.reworkCount === 1 ? '' : 's'} · {task.handoffCount} handoff{task.handoffCount === 1 ? '' : 's'}
        </dd>
      </dl>
      {task.blockerReason ? (
        <p className="bd-blocker" data-testid="card-blocker" role="note">
          {task.blockerReason}
        </p>
      ) : null}

      {problem ? <Alert>{problem}</Alert> : null}
      {filed ? <p className="bd-filed" role="status">{filed}</p> : null}

      <div className="bd-panel-actions">
        {task.ownerId === null ? (
          <button type="button" className="btn s" disabled={busy !== null} onClick={() => void run('claim', () => claimTask(slug, task.id))} data-testid="card-claim">
            Claim
          </button>
        ) : (
          <button type="button" className="btn s" disabled={busy !== null} onClick={() => void run('release', () => releaseTask(slug, task.id))} data-testid="card-release">
            Release
          </button>
        )}
        {task.state !== 'done' ? (
          <button type="button" className="btn s" disabled={busy !== null} onClick={() => void complete()} data-testid="card-complete">
            Complete
          </button>
        ) : null}
        {task.state !== 'done' && task.state !== 'open' ? (
          <button
            type="button"
            className="btn s"
            disabled={busy !== null}
            onClick={() => void run('rework', () => reworkTask(slug, task.id, { reason: note.trim() }))}
            data-testid="card-rework"
          >
            Send back
          </button>
        ) : null}
      </div>

      <label className="bd-field">
        <span>Tested commit / note</span>
        <input value={testedSha} onChange={(e) => setTestedSha(e.target.value)} placeholder="the sha that was tested" className="mono" data-testid="card-tested-sha" />
      </label>
      <label className="bd-field">
        <span>Note (sent back, or handed over)</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="what the next owner should know" data-testid="card-note" />
      </label>

      {targets.length > 0 ? (
        <div className="bd-move">
          <label className="bd-field">
            <span>Move to</span>
            <select value={to} onChange={(e) => setTo(e.target.value)} data-testid="card-move-target">
              {targets.map((c) => (
                <option key={c.id} value={c.id} data-state={c.state}>
                  {c.name === STATE_LABEL[c.state] ? c.name : `${c.name} (${STATE_LABEL[c.state]})`}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn s" disabled={busy !== null || to === ''} onClick={() => { const col = targets.find((c) => c.id === to); if (col) void onMove(task, col); }} data-testid="card-move">
            Move
          </button>
        </div>
      ) : null}

      {bots.length > 0 && task.state !== 'done' ? (
        <div className="bd-handoff">
          <label className="bd-field">
            <span>Hand to a bot</span>
            <select value={botSlug} onChange={(e) => setBotSlug(e.target.value)} data-testid="card-handoff-bot">
              {bots.map((b) => (
                <option key={b.slug} value={b.slug}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="bd-check">
            <input type="checkbox" checked={strict} onChange={(e) => setStrict(e.target.checked)} data-testid="card-handoff-strict" />
            <span>Wait for an approval (`dispatch: strict`)</span>
          </label>
          <button type="button" className="btn s" disabled={busy !== null || botSlug === ''} onClick={() => void handoff()} data-testid="card-handoff">
            Hand over
          </button>
        </div>
      ) : null}

      <h4 className="bd-history-title">History</h4>
      {eventsQ.status === 'loading' ? (
        <p className="loading" aria-busy="true">Loading…</p>
      ) : eventsQ.status === 'error' ? (
        <p className="bd-muted">The history could not be loaded.</p>
      ) : events.length === 0 ? (
        <p className="bd-muted">Nothing has happened to this card yet.</p>
      ) : (
        <ol className="bd-history" data-testid="card-history">
          {events.map((e) => (
            <li key={e.id} data-event={e.type}>
              <span className="bd-who">{nameOf(e.actorId)}</span> {eventLine(e, nameOf)}
              <span className="bd-when"><Time iso={e.createdAt} /></span>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
