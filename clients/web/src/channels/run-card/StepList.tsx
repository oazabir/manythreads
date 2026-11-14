import { useState, type ComponentType } from 'react';
import type { RunPlanEntry } from '@manythreads/shared';
import { CheckIcon, DownIcon, NextIcon, StepAskIcon, StepEditIcon, StepFailedIcon, StepMoveIcon, StepOtherIcon, StepReadIcon, StepRemoveIcon, StepRunIcon, StepSearchIcon, StepThinkIcon, StepWebIcon } from '../../shell/icons';
import { elapsedText } from './words';
import { helperSteps, PAGE_ROWS, TAIL_ROWS, type GroupRow, type HelperRow, type QuestionRow, type Row, type StepRow, type ThinkingRow } from './steps';

/*
 * The opened parts of a run card (PLAN P25-11, docs/plans/acp.md section 5.2): the plan, and the step list. One line per step, an icon by kind, a word for the state (never
 * colour alone), the newest at the bottom; a long list shows its last eight with "Show all N".
 */

const KIND_ICON: Record<string, ComponentType> = {
  read: StepReadIcon,
  edit: StepEditIcon,
  delete: StepRemoveIcon,
  move: StepMoveIcon,
  search: StepSearchIcon,
  execute: StepRunIcon,
  fetch: StepWebIcon,
  think: StepThinkIcon,
  switch_mode: StepOtherIcon,
  other: StepOtherIcon,
};

function Kind({ kind }: { kind: string }) {
  const Icon = KIND_ICON[kind] ?? StepOtherIcon;
  return <span className="rcIc" data-kind={kind}><Icon /></span>;
}

/** The end of a step's line: working, ticked or failed, in an icon and in words for a screen reader. */
function Status({ status }: { status: StepRow['status'] }) {
  if (status === 'working') return <span className="rcSt rcStWorking" role="img" aria-label="Working"><span className="rcPulse" /></span>;
  if (status === 'failed') return <span className="rcSt rcStFailed"><StepFailedIcon /><span>Failed</span></span>;
  return <span className="rcSt rcStDone" role="img" aria-label="Done"><CheckIcon size={12} /></span>;
}

function Step({ row }: { row: StepRow }) {
  const meta: string[] = [];
  if (row.diff !== null && (row.diff.added > 0 || row.diff.removed > 0)) meta.push(`+${row.diff.added} −${row.diff.removed}`);
  if (row.seconds !== null && row.seconds >= 1) meta.push(elapsedText(row.seconds * 1000));
  return (
    <li className="rcStep" data-status={row.status} data-kind={row.kind}>
      <Kind kind={row.kind} />
      <span className="rcText">
        {row.mono ? <code className="rcMono">{row.text}</code> : row.text}
        {row.files.map((f) => <span key={f} className="rcFile">{f}</span>)}
      </span>
      {meta.length > 0 ? <span className="rcMeta">{meta.join(' · ')}</span> : null}
      <Status status={row.status} />
    </li>
  );
}

function Group({ row }: { row: GroupRow }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rcStep rcGroup" data-kind={row.kind}>
      <Kind kind={row.kind} />
      <button type="button" className="rcFold" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="rcText">{row.text}</span>
        <span className="rcChev" aria-hidden="true">{open ? <DownIcon /> : <NextIcon />}</span>
      </button>
      {open ? (
        <ul className="rcList rcInner">
          {row.steps.map((s) => <Step key={s.id} row={s} />)}
        </ul>
      ) : null}
    </li>
  );
}

function Helper({ row, defaultOpen }: { row: HelperRow; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const word = row.status === 'working' ? 'working' : row.status === 'failed' ? 'failed' : 'done';
  return (
    <li className="rcStep rcHelper" data-status={row.status}>
      <span className="rcIc" data-kind="helper"><StepOtherIcon /></span>
      <button type="button" className="rcFold" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={row.name}>
        <span className="rcText"><span className="rcTag">Helper</span> {row.name}</span>
        <span className="rcMeta">{helperSteps(row.stepCount)} · {word}</span>
        <span className="rcChev" aria-hidden="true">{open ? <DownIcon /> : <NextIcon />}</span>
      </button>
      {row.status === 'working' ? <Status status="working" /> : row.status === 'failed' ? <Status status="failed" /> : null}
      {open ? (
        row.rows.length > 0 ? <ul className="rcList rcInner rcHelperRows">{row.rows.map((r) => <RowView key={r.id} row={r} defaultOpen={false} />)}</ul> : <p className="rcNone">No steps shown yet.</p>
      ) : null}
    </li>
  );
}

function Thinking({ row }: { row: ThinkingRow }) {
  return (
    <li className="rcStep rcThought">
      <Kind kind="think" />
      <span className="rcText">Thought for {elapsedText(row.seconds * 1000)}</span>
    </li>
  );
}

function Question({ row }: { row: QuestionRow }) {
  const word = row.outcome === 'asked' ? 'Asked you' : row.outcome === 'approved' ? 'Allowed' : row.outcome === 'denied' ? 'Not allowed' : 'Not answered';
  return (
    <li className="rcStep rcAsk" data-outcome={row.outcome}>
      <span className="rcIc" data-kind="ask"><StepAskIcon /></span>
      <span className="rcText"><span className="rcTag">{word}</span> {row.text}</span>
    </li>
  );
}

function RowView({ row, defaultOpen }: { row: Row; defaultOpen: boolean }) {
  switch (row.type) {
    case 'step':
      return <Step row={row} />;
    case 'group':
      return <Group row={row} />;
    case 'helper':
      return <Helper row={row} defaultOpen={defaultOpen} />;
    case 'thinking':
      return <Thinking row={row} />;
    case 'question':
      return <Question row={row} />;
  }
}

/** The most helpers drawn before "+N more helpers". */
const HELPERS_SHOWN = 3;

/** The step list: the newest rows, with Show all for the rest. `open` opens the helpers (the Trace view). */
export function StepList({ rows, loading, trace }: { rows: readonly Row[]; loading: boolean; trace: boolean }) {
  const [all, setAll] = useState(false);
  const [shown, setShown] = useState(PAGE_ROWS);
  const [moreHelpers, setMoreHelpers] = useState(false);
  if (rows.length === 0) return <p className="rcNone" role="status">{loading ? 'Loading the steps…' : 'No steps yet.'}</p>;

  // helpers beyond the third are folded behind one button, unless the person asked for them
  let helperSeen = 0;
  const hidden: string[] = [];
  const visible = rows.filter((r) => {
    if (r.type !== 'helper') return true;
    helperSeen += 1;
    if (helperSeen > HELPERS_SHOWN && !moreHelpers) {
      hidden.push(r.id);
      return false;
    }
    return true;
  });
  const slice = all ? visible.slice(0, shown) : visible.slice(-TAIL_ROWS);
  const earlier = visible.length - slice.length;
  return (
    <div className="rcSteps" data-testid="run-steps">
      {!all && earlier > 0 ? (
        <button type="button" className="rcMore" onClick={() => setAll(true)}>Show all {visible.length}</button>
      ) : null}
      <ul className="rcList">
        {slice.map((r) => <RowView key={r.id} row={r} defaultOpen={trace} />)}
      </ul>
      {all && visible.length > shown ? (
        <button type="button" className="rcMore" onClick={() => setShown((n) => n + PAGE_ROWS)}>Show {Math.min(PAGE_ROWS, visible.length - shown)} more</button>
      ) : null}
      {hidden.length > 0 ? (
        <button type="button" className="rcMore" onClick={() => setMoreHelpers(true)}>+{hidden.length} more {hidden.length === 1 ? 'helper' : 'helpers'}</button>
      ) : null}
    </div>
  );
}

/** The agent's plan, one line per item, the done ones ticked. */
export function PlanList({ plan }: { plan: readonly RunPlanEntry[] }) {
  if (plan.length === 0) return <p className="rcNone">No plan yet.</p>;
  return (
    <ol className="rcList rcPlanList" data-testid="run-plan">
      {plan.map((p, i) => (
        <li key={i} className="rcPlanItem" data-status={p.status}>
          <span className="rcPlanMark" aria-hidden="true">{p.status === 'completed' ? <CheckIcon size={12} /> : p.status === 'in_progress' ? <span className="rcPulse" /> : null}</span>
          <span className="rcText">{p.content}</span>
          <span className="sr-only">{p.status === 'completed' ? ' (done)' : p.status === 'in_progress' ? ' (now)' : ' (to do)'}</span>
        </li>
      ))}
    </ol>
  );
}
