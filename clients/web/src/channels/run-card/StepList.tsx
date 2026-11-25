import { useEffect, useState, type ComponentType } from 'react';
import type { RunPlanEntry } from '@manythreads/shared';
import { CheckIcon, DownIcon, NextIcon, StepAskIcon, StepEditIcon, StepFailedIcon, StepHelperIcon, StepMoveIcon, StepOtherIcon, StepReadIcon, StepRemoveIcon, StepRunIcon, StepSearchIcon, StepThinkIcon, StepWebIcon } from '../../shell/icons';
import { elapsedText } from './words';
import { helperSteps, helpersToHide, PAGE_ROWS, TAIL_ROWS, type GroupRow, type HelperRow, type QuestionRow, type Row, type StepRow, type ThinkingRow } from './steps';

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
function Status({ status, outOfMemory }: { status: StepRow['status']; outOfMemory?: boolean | undefined }) {
  if (status === 'working') return <span className="rcSt rcStWorking" role="img" aria-label="Working"><span className="rcPulse" /></span>;
  // a command stopped for using more memory than the run may (P31-04): the run went on, the step says why it ended
  if (status === 'failed') return <span className="rcSt rcStFailed"><StepFailedIcon /><span>{outOfMemory === true ? 'Out of memory' : 'Failed'}</span></span>;
  return <span className="rcSt rcStDone" role="img" aria-label="Done"><CheckIcon size={12} /></span>;
}

function Step({ row }: { row: StepRow }) {
  const meta: string[] = [];
  if (row.diff !== null && (row.diff.added > 0 || row.diff.removed > 0)) meta.push(row.diff.removed > 0 ? `+${row.diff.added} −${row.diff.removed}` : `+${row.diff.added}`);
  if (row.seconds !== null && row.seconds >= 1) meta.push(elapsedText(row.seconds * 1000));
  return (
    <li className="rcStep" data-status={row.status} data-kind={row.kind}>
      <Kind kind={row.kind} />
      <span className="rcText" dir="auto">
        {row.text}
        {row.code !== null ? <> <code className="rcCode" dir="ltr">{row.code}</code></> : null}
        {row.files.map((f) => <span key={f} className="rcFile" dir="ltr">{f}</span>)}
      </span>
      {row.answer !== undefined || meta.length > 0 ? (
        <span className="rcMeta">
          {row.answer !== undefined ? <span className="rcAnswer" data-outcome={row.answer}>{ANSWER_WORD[row.answer]}</span> : null}
          {row.answer !== undefined && meta.length > 0 ? ' · ' : null}
          {meta.join(' · ')}
        </span>
      ) : null}
      <Status status={row.status} outOfMemory={row.outOfMemory} />
    </li>
  );
}

function Group({ row }: { row: GroupRow }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rcStep rcGroup" data-kind={row.kind}>
      <Kind kind={row.kind} />
      <button type="button" className="rcFold" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="rcText" dir="auto">{row.text}</span>
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
  // switching to Trace opens the helpers, and back closes them; a person's own click in between still works
  useEffect(() => setOpen(defaultOpen), [defaultOpen]);
  return (
    <li className="rcStep rcHelper" data-status={row.status}>
      <span className="rcIc" data-kind="helper"><StepHelperIcon /></span>
      <button type="button" className="rcFold" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={row.name}>
        <span className="rcText"><span className="rcTag">Helper</span> <bdi>{row.name}</bdi></span>
        <span className="rcMeta">{helperSteps(row.stepCount)}</span>
        <span className="rcChev" aria-hidden="true">{open ? <DownIcon /> : <NextIcon />}</span>
      </button>
      <Status status={row.status} />
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

/** A person's answer to a step that asked first, in a word. */
const ANSWER_WORD: Record<QuestionRow['outcome'], string> = { asked: 'Waiting for an answer', approved: 'Allowed', denied: 'Not allowed', ended: 'No answer' };

/** A question to a person: what it asked to do, and the answer in a word at the end of the line. */
function Question({ row }: { row: QuestionRow }) {
  const word = ANSWER_WORD[row.outcome];
  return (
    <li className="rcStep rcAsk" data-outcome={row.outcome}>
      <span className="rcIc" data-kind="ask"><StepAskIcon /></span>
      <span className="rcText" dir="auto">
        <span className="rcAskLead">Asked to</span> {row.text.charAt(0).toLowerCase()}{row.text.slice(1)}
        {row.code !== null ? <> <code className="rcCode" dir="ltr">{row.code}</code></> : null}
      </span>
      <span className="rcMeta rcAnswer">{word}</span>
    </li>
  );
}

export function RowView({ row, defaultOpen }: { row: Row; defaultOpen: boolean }) {
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

/** The step list: the newest rows, with Show all for the rest (earlier rows are added above, a page at a time). `trace` opens the helpers (the Trace view). */
export function StepList({ rows, loading, trace }: { rows: readonly Row[]; loading: boolean; trace: boolean }) {
  const [shown, setShown] = useState(TAIL_ROWS);
  const [moreHelpers, setMoreHelpers] = useState(false);
  if (rows.length === 0) return <p className="rcNone" role="status">{loading ? 'Loading the steps…' : 'No steps yet.'}</p>;

  const hidden = moreHelpers ? new Set<string>() : helpersToHide(rows);
  const visible = rows.filter((r) => !hidden.has(r.id));
  // always the newest rows: "Show all" grows the window upwards, a page at a time, so the newest stay in place
  const slice = visible.slice(-shown);
  const earlier = visible.length - slice.length;
  return (
    <div className="rcSteps" data-testid="run-steps" tabIndex={0} role="region" aria-label="Steps">
      {earlier > 0 ? (
        <button type="button" className="rcMore" onClick={() => setShown((n) => (n === TAIL_ROWS ? PAGE_ROWS : n + PAGE_ROWS))}>
          {shown === TAIL_ROWS ? `Show all ${visible.length}` : `Show ${Math.min(PAGE_ROWS, earlier)} earlier`}
        </button>
      ) : null}
      <ul className="rcList">
        {slice.map((r) => <RowView key={r.id} row={r} defaultOpen={trace} />)}
      </ul>
      {hidden.size > 0 ? (
        <button type="button" className="rcMore" onClick={() => setMoreHelpers(true)}>+{hidden.size} more {hidden.size === 1 ? 'helper' : 'helpers'}</button>
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
          <span className="rcPlanMark" aria-hidden="true">{p.status === 'completed' ? <CheckIcon size={12} /> : p.status === 'in_progress' ? <span className="rcPulse" /> : <span className="rcTodoDot" />}</span>
          <span className="rcText" dir="auto">{p.content}</span>
          <span className="sr-only">{p.status === 'completed' ? ' (done)' : p.status === 'in_progress' ? ' (now)' : ' (to do)'}</span>
        </li>
      ))}
    </ol>
  );
}
