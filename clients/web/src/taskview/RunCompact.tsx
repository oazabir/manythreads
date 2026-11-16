import { useCallback, useMemo, useState } from 'react';
import type { RunActivityItem, RunHead } from '@manythreads/shared';
import { Avatar } from '../components/ui';
import { stopThreadRun } from '../runs/api';
import { StepDoneIcon, StepFailedIcon, StepStoppedIcon, StopIcon } from '../shell/icons';
import { useClock } from '../channels/run-card/hooks';
import { buildRows } from '../channels/run-card/steps';
import { RowView } from '../channels/run-card/StepList';
import { elapsedText, endLine, hasWork, nowLine, runElapsedMs, runEnded, stateWord, workParts } from '../channels/run-card/words';
import type { People } from '../channels/hooks';

/** The last rows of steps the compact run card shows (the owner asked for three or four, like the mockup). */
export const COMPACT_STEPS = 3;

function Parts({ parts }: { parts: readonly string[] }) {
  return (
    <>
      {parts.map((p, i) => (
        <span key={`${i}:${p}`}>
          {i > 0 ? ' · ' : null}
          <span className="rcPart">{p}</span>
        </span>
      ))}
    </>
  );
}

/**
 * The run in the channel, compact (P29): who, the state, the time, Stop, what it is doing now, the counts, and the last three steps. It is not a live region (the channel has
 * one); the thread keeps the full card. `onOpen` opens the thread for everything else (the plan, every step, the answer so far).
 */
export function RunCompact({ head, lines, people, onOpen, more = 0 }: { head: RunHead; lines: readonly RunActivityItem[]; people: People; onOpen: () => void; more?: number }) {
  const live = !runEnded(head.state);
  const now = useClock(live);
  const [error, setError] = useState<string | null>(null);
  // the card says "stopping" at once; the server's own state arrives with the next push, and a refusal sets it back
  const [asked, setAsked] = useState(false);
  const stopping = head.state === 'stopping' || asked;
  const avatar = head.botActorId !== null ? people.botAvatar(head.botActorId) : undefined;
  const line = nowLine(head.now, head.state);
  const parts = workParts(head.counts);
  const rows = useMemo(() => buildRows(lines).filter((r) => r.type !== 'thinking' && r.type !== 'question').slice(-COMPACT_STEPS), [lines]);
  const elapsedMs = runElapsedMs(head, now);
  const elapsed = elapsedMs >= 1000 ? elapsedText(elapsedMs) : null;
  const stop = useCallback(async () => {
    if (stopping) return;
    setError(null);
    setAsked(true);
    try {
      await stopThreadRun(head.runId);
    } catch {
      setAsked(false);
      setError('Could not stop it. Try again.');
    }
  }, [head.runId, stopping]);
  return (
    <section className="tvCard tvRun rc" data-testid="tv-run" data-state={head.state} data-run-id={head.runId} aria-label={`${head.botName}, ${stateWord(head.state)}`}>
      <header className="rcHead">
        <Avatar name={head.botName} kind="agent" avatar={avatar ?? null} />
        <b className="rcName" dir="auto">{head.botName}</b>
        <span className="rcState" data-state={head.state} data-testid="tv-run-state">{stateWord(head.state)}</span>
        {elapsed !== null ? <span className="rcTime" data-vt-mask aria-hidden="true">{elapsed}</span> : null}
        <span className="rcActs">
          {head.canStop ? (
            <button type="button" className="rcStop tvStop" aria-label={`Stop ${head.botName}`} aria-disabled={stopping} onClick={() => void stop()} data-testid="tv-run-stop">
              <StopIcon size={12} />
              <span>{stopping ? 'Stopping…' : 'Stop'}</span>
            </button>
          ) : null}
        </span>
      </header>
      <p className="rcNow" data-testid="tv-run-now">
        {head.state === 'working' || head.state === 'starting' ? <span className="rcPulse" aria-hidden="true" /> : null}
        <span className="rcNowText" dir="auto">{line.text}</span>
        {line.code !== null ? <code className="rcCode" dir="ltr">{line.code}</code> : null}
      </p>
      {error !== null ? <p className="rcError" role="alert">{error}</p> : null}
      {rows.length > 0 ? (
        <ul className="rcList tvSteps" data-testid="tv-run-steps">
          {rows.map((r) => <RowView key={r.id} row={r} defaultOpen={false} />)}
        </ul>
      ) : null}
      <p className="tvFoot">
        {parts.length > 0 ? <span className="tvParts" data-testid="tv-run-work"><Parts parts={parts} /></span> : <span />}
        {more > 0 ? <span className="tvMoreRuns" data-testid="tv-run-more">and {more} more {more === 1 ? 'is' : 'are'} working</span> : null}
        <button type="button" className="tvLink" onClick={onOpen} data-testid="tv-open-thread">Open thread</button>
      </p>
    </section>
  );
}

/** What stays after the run: one quiet line ("Worked 4 min · 14 steps"), with the thread one press away. */
export function RunEndedLine({ head, onOpen }: { head: RunHead; onOpen: () => void }) {
  const line = endLine(head, Date.now());
  const Icon = line.tone === 'failed' ? StepFailedIcon : line.tone === 'stopped' ? StepStoppedIcon : StepDoneIcon;
  const text = [line.lead, ...line.parts];
  return (
    <p className="tvEnded rcEnd" data-testid="tv-run-ended" data-tone={line.tone} data-run-id={head.runId}>
      <span className="rcEndIc" aria-hidden="true"><Icon /></span>
      <span className="rcEndText" dir="auto"><b>{head.botName}</b> · <Parts parts={text} /></span>
      {hasWork(head.counts) || line.tone !== 'done' ? <button type="button" className="tvLink" onClick={onOpen}>Open thread</button> : null}
    </p>
  );
}
