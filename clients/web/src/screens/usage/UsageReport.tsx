import type { ReactNode } from 'react';
import type { AnswerQuality, UsageAliasRow, UsageBudget, UsageDay, UsageRange, UsageTotals } from '@manythreads/shared';
import { RANGES, budgetView, count, percent, perAnswer, usd, usdOrHidden, waitText } from './format';
import { PageHeader } from '../../components/PageHeader';

/** What every usage page shares: the answer's common part. */
export interface UsageBody {
  range: UsageRange;
  totals: UsageTotals;
  daily: UsageDay[];
  spendByAlias: UsageAliasRow[];
  quality: AnswerQuality;
  budget: UsageBudget | null;
  generatedAt: string;
}

export function RangePicker({ days, onPick }: { days: number; onPick: (days: number) => void }) {
  return (
    <div className="usage-range" role="group" aria-label="How far back to look" data-testid="usage-range">
      {RANGES.map((r) => (
        <button key={r.days} type="button" className="btn s" aria-pressed={r.days === days} onClick={() => onPick(r.days)}>
          {r.label}
        </button>
      ))}
    </div>
  );
}

function Kpi({ label, value, note, testId }: { label: string; value: string; note?: string; testId: string }) {
  return (
    <div className="usage-kpi" data-testid={testId}>
      <div className="usage-kpi-n">{value}</div>
      <div className="usage-kpi-l">{label}</div>
      {note ? <div className="usage-kpi-note d">{note}</div> : null}
    </div>
  );
}

/** The headline numbers. Money shows "Admins only" for a reader the server did not give it to. */
export function Headline({ totals }: { totals: UsageTotals }) {
  return (
    <div className="usage-kpis" data-testid="usage-headline">
      <Kpi testId="usage-runs" label="Bot runs" value={count(totals.runs)} note={totals.failedRuns > 0 ? `${count(totals.failedRuns)} failed` : 'none failed'} />
      <Kpi
        testId="usage-tools"
        label="Tool calls"
        value={count(totals.toolCalls)}
        note={totals.toolsRefused + totals.toolsHeldForApproval > 0 ? `${count(totals.toolsRefused)} refused, ${count(totals.toolsHeldForApproval)} waited for a person` : 'none refused'}
      />
      <Kpi testId="usage-answers" label="Answers" value={count(totals.answers)} note={`${count(totals.answersScoped)} for one person, ${count(totals.answersFull)} for everyone`} />
      <Kpi
        testId="usage-approvals"
        label="Approvals asked"
        value={count(totals.approvalsAsked)}
        note={`${count(totals.approvalsApproved)} approved, ${count(totals.approvalsDenied)} denied · wait ${waitText(totals.approvalWaitSeconds)}`}
      />
      <Kpi testId="usage-spend" label="Model spend" value={usdOrHidden(totals.spendUsd)} note={totals.llmCalls === null ? 'Only workspace admins see money.' : `${count(totals.llmCalls)} calls · ${count(totals.tokens ?? 0)} tokens`} />
    </div>
  );
}

export function BudgetBar({ budget, subject }: { budget: UsageBudget; subject: string }) {
  const v = budgetView(budget);
  return (
    <section className="box" aria-labelledby="usage-budget" data-testid="usage-budget">
      <h2 className="box-h" id="usage-budget">{subject} budget</h2>
      <div className={`usage-meter ${v.tone}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={v.fill} aria-label={`${subject} budget used`}>
        <div className="usage-meter-fill" style={{ width: `${v.fill}%` }} />
      </div>
      <p className="d">{v.text}</p>
    </section>
  );
}

export function SpendByModel({ rows }: { rows: UsageAliasRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="box" aria-labelledby="usage-models" data-testid="usage-models">
      <h2 className="box-h" id="usage-models">Spend by model</h2>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th scope="col">Model alias</th><th scope="col">Spent</th><th scope="col">Calls</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.alias}>
                <td data-label="Model alias">{r.alias}</td>
                <td data-label="Spent" className="d-cell">{usd(r.spendUsd)}</td>
                <td data-label="Calls" className="d-cell">{count(r.calls)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** How good the answers were, in counts: what they cited, what the asker's access held back, and what the bot reached for. */
export function QualityPanel({ quality, title, hint }: { quality: AnswerQuality; title: string; hint?: string }) {
  return (
    <section className="box" aria-labelledby="usage-quality" data-testid="usage-quality">
      <h2 className="box-h" id="usage-quality">{title}</h2>
      {hint ? <p className="d">{hint}</p> : null}
      {quality.answers === 0 ? (
        <p className="faint">No answers in this range.</p>
      ) : (
        <>
          <div className="kv"><span className="k">Answers</span><span>{count(quality.answers)} ({count(quality.scoped)} for one person, {count(quality.full)} for everyone)</span></div>
          <div className="kv"><span className="k">Sources cited</span><span>{count(quality.citations)} · {perAnswer(quality.citationsPerAnswer)} per answer</span></div>
          <div className="kv"><span className="k">Sources held back</span><span>{count(quality.dropped)} · {percent(quality.droppedShare)} of what was found</span></div>
          <div className="kv"><span className="k">Sources looked at</span><span>{count(quality.sourcesReached)}</span></div>
          <div className="kv"><span className="k">Knowledge documents used</span><span>{count(quality.knowledgeHits)}</span></div>
        </>
      )}
      <p className="d">A source is held back when the person who asked is not allowed to read it. Only counts are kept here, never the question, the answer or the source text.</p>
    </section>
  );
}

export function Updated({ at, onRefresh }: { at: string; onRefresh: () => void }) {
  return (
    <p className="d usage-updated">
      Numbers as of {new Date(at).toLocaleString()}. Days are counted in UTC.{' '}
      <button type="button" className="btn s" onClick={onRefresh}>Refresh</button>
    </p>
  );
}

export function Page({ title, lede, children, testId, bare }: { title: string; lede: string; children: ReactNode; testId: string; bare?: boolean }) {
  // `bare`: the page is a route of its own (the bot's), not inside the settings frame, so it keeps its own side gutters
  return (
    <div className={bare ? 'usage-page usage-bare' : 'usage-page'} data-landmark="usage" data-testid={testId}>
      <PageHeader title={title} />
      <p className="lede" data-landmark="lede">{lede}</p>
      {children}
    </div>
  );
}
