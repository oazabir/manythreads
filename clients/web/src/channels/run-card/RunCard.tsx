import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Approval, RunHead } from '@manythreads/shared';
import { useQuery } from '../../app/useQuery';
import { Avatar } from '../../components/ui';
import { threadRunsStore } from '../../runs/store';
import { useRunAnswer, useRunLines } from '../../runs/useThreadRuns';
import { ApprovalCard } from '../../screens/approvals/ApprovalCard';
import { fetchThreadApprovals } from '../../screens/approvals/api';
import { useApprovalsChanged } from '../../screens/approvals/live';
import { CaretIcon, CheckIcon, MoreIcon, StepDoneIcon, StepFailedIcon, StepStoppedIcon, StopIcon } from '../../shell/icons';
import { useDismiss } from '../../shell/useDismiss';
import { useClock, useSteady } from './hooks';
import { buildRows } from './steps';
import { PlanList, StepList } from './StepList';
import { RUN_VIEWS, RUN_VIEW_LABEL, setRunView, useRunView, type RunView } from './runView';
import { leaveHandoff, setShownQuestions, takeHandoff } from './shownQuestions';
import { elapsedText, endLine, FAILURE_FALLBACK, nowLine, planLine, previewLines, runElapsedMs, runEnded, showsEndLine, stateWord, workParts, hasWork, type EndLine, type WaitingContext } from './words';
import type { People } from '../hooks';

/*
 * The run card (PLAN P25-11, docs/plans/acp.md section 5): what a bot and its helpers are doing, in the thread where the run answers.
 *  - `RunCard` is one live run: who, in what state and for how long, what it is doing now (one line, changed at most once a second, read out politely), the plan folded to its
 *    current item, the work done in counts a person who does not read code can read, the answer as it is written (faded), and, when it waits for a person, the question itself.
 *  - `RunEnd` is what is left under the bot's last message when the run is over: one quiet line that opens the same record.
 * Nothing here shows reasoning, tool output or a diff; the step list shows kinds, titles and file names only.
 */

/** The questions this run asked and nobody has answered: the thread's pending approvals from the same bot that a person can see. */
function useQuestions(rootId: string | null, enabled: boolean): { pending: Approval[]; failed: boolean; reload: () => void } {
  const q = useQuery(`run-questions:${rootId ?? ''}:${enabled}`, () => (enabled && rootId !== null ? fetchThreadApprovals(rootId) : Promise.resolve({ items: [] as Approval[] })));
  useApprovalsChanged(q.reload);
  const pending = useMemo(() => (q.status === 'ok' ? q.data.items.filter((a) => a.status === 'pending' && a.source === 'agent') : []), [q]);
  return { pending, failed: q.status === 'error', reload: q.reload };
}

/** Which of a thread's runs are waiting for a person: the thread's own list of approvals hides the ones the run card shows. */
export const asksOf = (a: Approval, head: Pick<RunHead, 'botId'>): boolean => a.status === 'pending' && a.source === 'agent' && a.botId === head.botId;

/** Who is expected to answer a question the viewer cannot: the one person it names, else the team's leads (a person cannot answer their own request). */
export function whoAnswers(a: Approval | undefined, people: People): string | null {
  if (a === undefined) return null;
  const named = a.approvers.people.length === 1 ? people.byPerson(a.approvers.people[0]!)?.name : undefined;
  if (named !== undefined) return named;
  return a.approvers.leads ? 'a team lead' : null;
}

function Pulse() {
  return <span className="rcPulse" aria-hidden="true" />;
}

/** How much of each run to show: Summary, Progress or Trace. Behind a "more" button, as in a message's own menu: set once, rarely touched. */
function ViewMenu() {
  const view = useRunView();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), box);
  return (
    <div className="rcView" ref={box}>
      <button type="button" className="rcIconBtn" aria-haspopup="menu" aria-expanded={open} aria-label="How much to show" title="How much to show" onClick={() => setOpen((o) => !o)} data-testid="run-view">
        <MoreIcon size={16} />
      </button>
      {open ? (
        <div className="menu rcMenu" role="menu" aria-label="How much to show">
          <p className="rcMenuHead" aria-hidden="true">Show for every run</p>
          {RUN_VIEWS.map((v: RunView) => (
            <button key={v} type="button" role="menuitemradio" aria-checked={view === v} className="rcMenuItem" onClick={() => { setRunView(v); setOpen(false); }}>
              <span className="rcMenuMark" aria-hidden="true">{view === v ? <CheckIcon size={12} /> : null}</span>
              <span className="rcMenuWords">
                <b>{RUN_VIEW_LABEL[v].label}</b>
                <small>{RUN_VIEW_LABEL[v].hint}</small>
              </span>
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

/** A fold button: a line of words and a caret, a real button that says whether it is open. Its name is its words. */
function Fold({ open, onToggle, testId, children, wraps = false }: { open: boolean; onToggle: () => void; testId: string; children: ReactNode; wraps?: boolean }) {
  return (
    <button type="button" className="rcFold rcFoldLine" aria-expanded={open} onClick={onToggle} data-testid={testId}>
      <span className={`rcFoldText${wraps ? ' rcWraps' : ''}`}>{children}</span>
      <span className="rcChev" aria-hidden="true"><CaretIcon open={open} /></span>
    </button>
  );
}

export interface RunCardProps {
  head: RunHead;
  /** The thread the card sits in (Stop, the questions and the answer so far go through it). */
  rootId: string;
  slug: string | null;
  people: People;
  /** The same bot keeps this thread's to-do card, which is its plan: the card does not draw a plan of its own. */
  hidePlan?: boolean;
  /** In a person's conversation, whose own Stop button sits by the box. */
  hideStop?: boolean;
  /** No faded preview of the answer (the conversation view writes the answer itself). */
  hidePreview?: boolean;
  /**
   * The message just above is the same bot's: the card continues it, under its text, without a second picture and name (the to-do card and the run that keeps it read as
   * one message).
   */
  continued?: boolean;
}

export function RunCard({ head, rootId, slug, people, hidePlan = false, hideStop = false, hidePreview = false, continued = false }: RunCardProps) {
  const view = useRunView();
  const live = !runEnded(head.state);
  const now = useClock(live);
  const answer = useRunAnswer(hidePreview ? null : rootId, head.runId);
  const [planOpen, setPlanOpen] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(view === 'trace');
  const [stopError, setStopError] = useState<string | null>(null);
  const waiting = head.state === 'waiting';
  const { pending, failed, reload } = useQuestions(rootId, waiting);
  const mine = useMemo(() => pending.filter((a) => asksOf(a, head)), [pending, head]);
  const drawn = slug !== null ? mine : [];
  const ctx: WaitingContext = {
    viewerCanAnswer: mine.some((a) => a.canDecide),
    waitingFor: whoAnswers(mine[0], people),
  };
  const word = stateWord(head.state, ctx);
  // the now line moves at most once a second: a screen reader hears each change once, and a person can read it
  const line = useSteady(nowLine(head.now, head.state));
  const plan = hidePlan ? null : planLine(head.plan);
  const parts = workParts(head.counts);
  const showWork = view !== 'summary';
  const showPlan = showWork && plan !== null;
  const lines = showWork && answer !== undefined ? previewLines(answer) : [];
  const avatar = head.botActorId !== null ? people.botAvatar(head.botActorId) : undefined;
  const stopping = head.state === 'stopping';
  const focused = useRef(false);
  const stepsRef = useRef(stepsOpen);
  stepsRef.current = stepsOpen;

  // Trace opens the step list, the other views fold it; a person's own click in between still works
  useEffect(() => setStepsOpen(view === 'trace'), [view]);

  // the thread's approvals strip leaves out exactly the questions drawn here
  const drawnIds = drawn.map((a) => a.id).join(',');
  useEffect(() => {
    setShownQuestions(rootId, head.runId, drawnIds === '' ? [] : drawnIds.split(','));
    return () => setShownQuestions(rootId, head.runId, []);
  }, [rootId, head.runId, drawnIds]);

  // when the run ends this card goes away and a folded line takes its place: it keeps the focus and the open step list
  const runId = head.runId;
  useEffect(() => () => leaveHandoff(runId, { focus: focused.current, open: stepsRef.current }), [runId]);

  // a failed Stop says so for a while, then the line goes away
  useEffect(() => {
    if (stopError === null) return;
    const t = setTimeout(() => setStopError(null), 6000);
    return () => clearTimeout(t);
  }, [stopError]);

  const stop = useCallback(async () => {
    if (stopping) return;
    setStopError(null);
    try {
      await threadRunsStore.stop(rootId, head.runId);
    } catch {
      setStopError('Could not stop it. Try again.');
    }
  }, [rootId, head.runId, stopping]);

  // no "0 s": the time shows from its first second
  const elapsedMs = runElapsedMs(head, now);
  const elapsed = elapsedMs >= 1000 ? elapsedText(elapsedMs) : null;
  const asking = drawn.length > 0;
  return (
    <div
      className={`rc${continued ? ' rcCont' : ''}`}
      role="group"
      data-testid="run-card"
      data-state={head.state}
      data-run-id={head.runId}
      data-view={view}
      aria-label={head.botName}
      onFocus={() => { focused.current = true; }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) focused.current = false; }}
    >
      <header className="rcHead">
        {continued ? null : <Avatar name={head.botName} kind="agent" avatar={avatar ?? null} />}
        {continued ? null : <b className="rcName" dir="auto">{head.botName}</b>}
        <span className="rcState" data-state={head.state} data-testid="run-state" role="status">{word}</span>
        {elapsed !== null ? <span className="rcTime" data-vt-mask aria-hidden="true">{elapsed}</span> : null}
        <span className="rcActs">
          <ViewMenu />
          {head.canStop && !hideStop ? (
            <button type="button" className="rcStop" aria-disabled={stopping} onClick={() => void stop()} data-testid="run-stop" aria-describedby={undefined}>
              <StopIcon size={12} />
              <span>{stopping ? 'Stopping…' : 'Stop'}</span>
            </button>
          ) : null}
        </span>
      </header>
      {asking ? null : (
        <p className="rcNow" aria-live="polite" aria-atomic="true" data-testid="run-now" title={line.helper ?? undefined}>
          {head.state === 'working' || head.state === 'starting' ? <Pulse /> : null}
          <span className="rcNowText" dir="auto">{line.text}</span>
          {line.code !== null ? <code className="rcCode" dir="ltr">{line.code}</code> : null}
        </p>
      )}
      {stopError !== null ? <p className="rcError" role="alert">{stopError}</p> : null}
      {showPlan && plan !== null ? (
        <Fold open={planOpen} onToggle={() => setPlanOpen((o) => !o)} testId="run-plan-fold">
          <span className="rcLead">Plan</span> <span className="rcNum">{plan.done} of {plan.total}</span>
          {plan.current !== null ? <> · <span className="rcCurrent" dir="auto">{plan.current}</span></> : null}
        </Fold>
      ) : null}
      {showWork && parts.length > 0 ? (
        <Fold open={stepsOpen} onToggle={() => setStepsOpen((o) => !o)} testId="run-work-fold" wraps>
          <span data-testid="run-work">{parts.join(' · ')}</span>
        </Fold>
      ) : null}
      {(showPlan && planOpen) || (showWork && stepsOpen) ? <RunDetails head={head} plan={showPlan && planOpen} steps={showWork && stepsOpen} trace={view === 'trace'} /> : null}
      {lines.length > 0 && !asking ? (
        <div className="rcPreview" data-testid="run-preview" data-lines={lines.length} aria-hidden="true">
          {lines.map((l, i) => <p key={`${i}:${l.slice(0, 12)}`} dir="auto">{l}</p>)}
        </div>
      ) : null}
      {asking && slug !== null ? (
        <div className="rcQs" data-testid="run-questions">
          {drawn.map((a) => <ApprovalCard key={a.id} approval={a} slug={slug} variant="run" onDecided={reload} />)}
        </div>
      ) : null}
      {waiting && failed ? (
        <p className="rcError" role="alert" data-testid="run-questions-error">
          Could not load its question. <button type="button" className="rcRetry" onClick={reload}>Try again</button>
        </p>
      ) : null}
    </div>
  );
}

/** The icon of how a run ended: status is never colour alone. */
function EndIcon({ tone }: { tone: EndLine['tone'] }) {
  return <span className="rcEndIc" aria-hidden="true">{tone === 'failed' ? <StepFailedIcon /> : tone === 'stopped' ? <StepStoppedIcon /> : <StepDoneIcon />}</span>;
}

/**
 * What stays under the bot's last message when its run is over: "Worked 4 min · 14 steps · 2 helpers", or who stopped it, or that it failed. It opens the record (read from the
 * server, so it is there after a reload and for someone who joined later). A run that did no steps and went well shows nothing.
 */
export function RunEnd({ head, noticeShown = false }: { head: RunHead; noticeShown?: boolean }) {
  const view = useRunView();
  const [handoff] = useState(() => takeHandoff(head.runId));
  const [open, setOpen] = useState(handoff?.open === true || view === 'trace');
  const fold = useRef<HTMLButtonElement>(null);
  useEffect(() => setOpen((o) => (view === 'trace' ? true : o)), [view]);
  useEffect(() => {
    if (handoff?.focus) fold.current?.focus();
  }, [handoff]);
  const line = endLine(head, Date.now());
  if (!showsEndLine(head)) return null;
  const openable = hasWork(head.counts);
  const text = [line.lead, ...line.parts].join(' · ');
  const isOpen = open && openable;
  return (
    <div className="rcEnd" data-testid="run-end" data-tone={line.tone} data-run-id={head.runId}>
      {openable ? (
        <button ref={fold} type="button" className="rcFold rcEndLine" aria-expanded={isOpen} onClick={() => setOpen((o) => !o)} data-testid="run-end-fold">
          <EndIcon tone={line.tone} />
          <span className="rcEndText">{text}</span>
          <span className="rcChev" aria-hidden="true"><CaretIcon open={isOpen} /></span>
        </button>
      ) : (
        <p className="rcEndLine rcEndPlain"><EndIcon tone={line.tone} /><span className="rcEndText">{text}</span></p>
      )}
      {line.tone === 'failed' && !noticeShown ? <p className="rcWho" data-testid="run-who">{FAILURE_FALLBACK}</p> : null}
      {isOpen ? <RunDetails head={head} plan={false} steps trace={view === 'trace'} /> : null}
    </div>
  );
}
