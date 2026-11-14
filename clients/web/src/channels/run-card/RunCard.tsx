import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Approval, RunHead } from '@manythreads/shared';
import { isApiError } from '../../api/client';
import { useQuery } from '../../app/useQuery';
import { Avatar } from '../../components/ui';
import { threadRunsStore } from '../../runs/store';
import { useRunLines } from '../../runs/useThreadRuns';
import { ApprovalCard } from '../../screens/approvals/ApprovalCard';
import { fetchThreadApprovals } from '../../screens/approvals/api';
import { useApprovalsChanged } from '../../screens/approvals/live';
import { CaretIcon, GearIcon, StopIcon } from '../../shell/icons';
import { useDismiss } from '../../shell/useDismiss';
import { useClock, useSteady } from './hooks';
import { buildRows } from './steps';
import { PlanList, StepList } from './StepList';
import { RUN_VIEWS, RUN_VIEW_LABEL, setRunView, useRunView, type RunView } from './runView';
import { elapsedText, endLine, FAILURE_FALLBACK, nowLine, planLine, previewLines, runElapsedMs, runEnded, showsEndLine, stateWord, workParts, hasWork, type WaitingContext } from './words';
import type { People } from '../hooks';

/*
 * The run card (PLAN P25-11, docs/plans/acp.md section 5): what a bot and its helpers are doing, in the thread where the run answers.
 *  - `RunCard` is one live run: who, in what state and for how long, what it is doing now (one line, changed at most once a second, read out politely), the plan folded to its
 *    current item, the work done in counts a person who does not read code can read, the answer as it is written (faded), and, when it waits for a person, the question itself.
 *  - `RunEnd` is what is left under the bot's last message when the run is over: one quiet line that opens the same record.
 * Nothing here shows reasoning, tool output or a diff; the step list shows kinds, titles and file names only.
 */

/** The questions this run asked and nobody has answered: the thread's pending approvals from the same bot that a person can see. */
function useQuestions(rootId: string | null, enabled: boolean): { pending: Approval[]; reload: () => void } {
  const q = useQuery(`run-questions:${rootId ?? ''}:${enabled}`, () => (enabled && rootId !== null ? fetchThreadApprovals(rootId) : Promise.resolve({ items: [] as Approval[] })));
  useApprovalsChanged(q.reload);
  const pending = useMemo(() => (q.status === 'ok' ? q.data.items.filter((a) => a.status === 'pending' && a.source === 'agent') : []), [q]);
  return { pending, reload: q.reload };
}

/** Which of a thread's runs are waiting for a person: the thread's own list of approvals hides the ones the run card shows. */
export const asksOf = (a: Approval, head: Pick<RunHead, 'botId'>): boolean => a.status === 'pending' && a.source === 'agent' && a.botId === head.botId;

function Pulse() {
  return <span className="rcPulse" aria-hidden="true" />;
}

/** The three views of how much to show. A menu, not a tab bar: it is set once and rarely touched. */
function ViewMenu() {
  const view = useRunView();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), box);
  return (
    <div className="rcView" ref={box}>
      <button type="button" className="rcIconBtn" aria-haspopup="menu" aria-expanded={open} aria-label="How much to show" title="How much to show" onClick={() => setOpen((o) => !o)}>
        <GearIcon size={14} />
      </button>
      {open ? (
        <div className="menu rcMenu" role="menu" aria-label="How much to show">
          {RUN_VIEWS.map((v: RunView) => (
            <button key={v} type="button" role="menuitemradio" aria-checked={view === v} className="rcMenuItem" onClick={() => { setRunView(v); setOpen(false); }}>
              <b>{RUN_VIEW_LABEL[v].label}</b>
              <small>{RUN_VIEW_LABEL[v].hint}</small>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The plan and the step list of a run, read when first opened and again as the run moves on. */
function RunDetails({ head, plan, steps, trace }: { head: RunHead; plan: boolean; steps: boolean; trace: boolean }) {
  const lines = useRunLines(head.runId, head.seq);
  const rows = useMemo(() => buildRows(lines.items), [lines.items]);
  return (
    <div className="rcDetails" data-testid="run-details">
      {plan ? <PlanList plan={lines.plan} /> : null}
      {steps ? <StepList rows={rows} loading={lines.loading} trace={trace} /> : null}
    </div>
  );
}

/** A fold button: a line of words and a caret, a real button that says whether it is open. */
function Fold({ open, onToggle, label, testId, children }: { open: boolean; onToggle: () => void; label: string; testId: string; children: ReactNode }) {
  return (
    <button type="button" className="rcFold rcFoldLine" aria-expanded={open} aria-label={label} onClick={onToggle} data-testid={testId}>
      <span className="rcFoldText">{children}</span>
      <span className="rcChev" aria-hidden="true"><CaretIcon open={open} /></span>
    </button>
  );
}

export interface RunCardProps {
  head: RunHead;
  /** The answer as it is written (the last lines are shown, faded). */
  answer: string | undefined;
  /** The thread the card sits in (Stop and the questions go through it). */
  rootId: string;
  slug: string | null;
  people: People;
  /** The same bot keeps this thread's to-do card, which is its plan: the card does not draw a plan of its own. */
  hidePlan?: boolean;
  /** In a person's conversation, whose own Stop button sits by the box. */
  hideStop?: boolean;
}

export function RunCard({ head, answer, rootId, slug, people, hidePlan = false, hideStop = false }: RunCardProps) {
  const view = useRunView();
  const live = !runEnded(head.state);
  const now = useClock(live);
  const [planOpen, setPlanOpen] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const waiting = head.state === 'waiting';
  const { pending, reload } = useQuestions(rootId, waiting);
  const mine = useMemo(() => pending.filter((a) => asksOf(a, head)), [pending, head]);
  const ctx: WaitingContext = {
    viewerCanAnswer: mine.some((a) => a.canDecide),
    waitingFor: mine[0]?.requesterName ?? (head.askerActorId !== null ? (people.byActor(head.askerActorId)?.name ?? null) : null),
  };
  const word = stateWord(head.state, ctx);
  // the now line moves at most once a second: a screen reader hears each change once, and a person can read it
  const line = useSteady(nowLine(head.now, head.state));
  const plan = hidePlan ? null : planLine(head.plan);
  const parts = workParts(head.counts);
  const showWork = view !== 'summary';
  const showPlan = showWork && plan !== null;
  const trace = view === 'trace';
  const stepsShown = stepsOpen || trace;
  const lines = showWork && answer !== undefined ? previewLines(answer) : [];
  const avatar = head.botActorId !== null ? people.botAvatar(head.botActorId) : undefined;
  const stopping = head.state === 'stopping';

  const stop = useCallback(async () => {
    setStopError(null);
    try {
      await threadRunsStore.stop(rootId, head.runId);
    } catch (e) {
      setStopError(isApiError(e) ? e.message : 'Could not stop it. Try again.');
    }
  }, [rootId, head.runId]);

  const elapsed = elapsedText(runElapsedMs(head, now));
  return (
    <section className="rc" data-testid="run-card" data-state={head.state} data-run-id={head.runId} data-view={view} aria-label={`${head.botName}: ${word}`}>
      <header className="rcHead">
        <Avatar name={head.botName} kind="agent" avatar={avatar ?? null} />
        <b className="rcName">{head.botName}</b>
        <span className="rcState" data-state={head.state} data-testid="run-state">
          {head.state === 'working' || head.state === 'starting' ? <Pulse /> : null}
          {word}
        </span>
        <span className="rcTime" data-vt-mask>{elapsed}</span>
        <span className="rcActs">
          <ViewMenu />
          {head.canStop && !hideStop ? (
            <button type="button" className="rcStop" disabled={stopping} onClick={() => void stop()} data-testid="run-stop" title="Stop. What it has written so far is kept.">
              <StopIcon size={12} />
              <span>{stopping ? 'Stopping…' : 'Stop'}</span>
            </button>
          ) : null}
        </span>
      </header>
      <span className="sr-only" role="status" data-testid="run-status">{word}</span>
      <p className="rcNow" aria-live="polite" aria-atomic="true" data-testid="run-now" title={line.helper ?? undefined}>
        <span className="rcNowText">{line.text}</span>
        {line.code !== null ? <code className="rcMono">{line.code}</code> : null}
      </p>
      {stopError !== null ? <p className="rcError" role="alert">{stopError}</p> : null}
      {showPlan && plan !== null ? (
        <Fold open={planOpen} onToggle={() => setPlanOpen((o) => !o)} label={`Plan: ${plan.done} of ${plan.total} done${plan.current ? `, now ${plan.current}` : ''}`} testId="run-plan-fold">
          <span className="rcLead">Plan</span> <span className="rcNum">{plan.done} of {plan.total}</span>
          {plan.current !== null ? <span className="rcCurrent"> · {plan.current}</span> : null}
        </Fold>
      ) : null}
      {showWork && parts.length > 0 ? (
        <Fold open={stepsShown} onToggle={() => setStepsOpen((o) => !o)} label={`Work so far: ${parts.join(', ')}`} testId="run-work-fold">
          <span data-testid="run-work">{parts.join(' · ')}</span>
        </Fold>
      ) : null}
      {(showPlan && planOpen) || (showWork && stepsShown) ? <RunDetails head={head} plan={showPlan && planOpen} steps={showWork && stepsShown} trace={trace} /> : null}
      {lines.length > 0 ? (
        <div className="rcPreview" data-testid="run-preview" aria-hidden="true">
          {lines.map((l, i) => <p key={`${i}:${l.slice(0, 12)}`}>{l}</p>)}
        </div>
      ) : null}
      {mine.length > 0 && slug !== null ? (
        <div className="rcQs" data-testid="run-questions">
          {mine.map((a) => <ApprovalCard key={a.id} approval={a} slug={slug} variant="thread" onDecided={reload} />)}
        </div>
      ) : null}
    </section>
  );
}

/**
 * What stays under the bot's last message when its run is over: "Worked 4 min · 14 steps · 2 helpers", or who stopped it, or that it failed. It opens the record (read from the
 * server, so it is there after a reload and for someone who joined later). A run that did no steps and went well shows nothing.
 */
export function RunEnd({ head, noticeShown = false }: { head: RunHead; noticeShown?: boolean }) {
  const [open, setOpen] = useState(false);
  const view = useRunView();
  const line = endLine(head);
  if (!showsEndLine(head)) return null;
  const openable = hasWork(head.counts);
  const text = [line.lead, ...line.parts].join(' · ');
  const isOpen = open || (view === 'trace' && openable);
  return (
    <div className="rcEnd" data-testid="run-end" data-tone={line.tone} data-run-id={head.runId}>
      {openable ? (
        <button type="button" className="rcFold rcEndLine" aria-expanded={isOpen} aria-label={`${head.botName}: ${text}`} onClick={() => setOpen((o) => !o)} data-testid="run-end-fold">
          <span className="rcEndText">{text}</span>
          <span className="rcChev" aria-hidden="true"><CaretIcon open={isOpen} /></span>
        </button>
      ) : (
        <p className="rcEndLine rcEndPlain"><span className="rcEndText">{text}</span></p>
      )}
      {line.tone === 'failed' && !noticeShown ? <p className="rcWho" data-testid="run-who">{FAILURE_FALLBACK}</p> : null}
      {isOpen && openable ? <RunDetails head={head} plan={false} steps trace={view === 'trace'} /> : null}
    </div>
  );
}
