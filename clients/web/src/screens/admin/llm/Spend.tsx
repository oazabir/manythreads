import { useState, type FormEvent } from 'react';
import type { TeamSummary } from '@manythreads/shared';
import { fetchLlmSpend } from '../../../api/endpoints';
import { useQuery } from '../../../app/useQuery';
import { QueryView } from '../../../components/states';
import { spendRange } from './spendRange';

/*
 * Workspace → LLM → Spend (SPEC §10.1 "observability", PLAN P5-07/P5-08). What the workspace actually paid, read from
 * the append-only `llm_spend` ledger — the same rows a budget check sums, so the report and the limit that fired can
 * never disagree about what a month cost.
 *
 * The default range is the current month, which is the window a monthly budget uses: open the page and the number you
 * see is the number the workspace cap is measured against. A date input is a calendar day; the range is sent as the
 * day's first instant and the day after, inclusive of the day chosen.
 */

const usd = (n: number) => `$${n.toFixed(2)}`;
const short = (id: string) => `${id.slice(0, 8)}…`;

/** Plain names for the calls that belong to no bot, by what they were for. */
const PURPOSE_LABELS: Record<string, string> = {
  setup: 'Add a bot helper',
  workshop: 'Workshop helper',
  'alias-test': 'Model test',
  gate: 'Safety check',
  eval: 'Scenario test run',
  rehearsal: 'Rehearsal',
  run: 'Bot work',
};
export const purposeLabel = (purpose: string | null): string => (purpose === null ? 'Not tied to a bot' : (PURPOSE_LABELS[purpose] ?? 'Other model calls'));

/** A bot in the by-bot table: its name and team when the server could name it; "Removed bot" when it no longer exists (the whole id is the cell's title either way, never shown as text). */
export function BotCell({ id, name, team, rehearsal = false }: { id: string; name: string | null; team: string | null; rehearsal?: boolean }) {
  if (name === null) return <span className="faint" title={id}>{rehearsal ? 'Rehearsal of a removed bot' : 'Removed bot'}</span>;
  return (
    <span title={id}>
      {rehearsal ? 'Rehearsal of ' : ''}
      {name}
      {team !== null ? <span className="faint"> · {team}</span> : null}
    </span>
  );
}

export function SpendSection({ teams }: { teams: TeamSummary[] }) {
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [range, setRange] = useState<{ since?: string; until?: string }>({});

  const q = useQuery(`llm-spend:${range.since ?? ''}:${range.until ?? ''}`, async () => (await fetchLlmSpend(range)).summary);
  // Keyed by the plain id string: the entity brands it as TeamId, the ledger's rows carry it unbranded.
  const teamName = new Map(teams.map((t) => [t.id as string, t.name]));

  function show(e: FormEvent) {
    e.preventDefault();
    setRange(spendRange(since, until));
  }

  return (
    <section className="block" aria-labelledby="llm-spend">
      <h2 className="bh" id="llm-spend">Spend</h2>
      <div className="block-body">
        <p className="lede">What model calls cost, and where the cost came from. This month unless you narrow it.</p>

        <form className="inline-form" onSubmit={show} data-testid="llm-spend-range">
          <div className="fld">
            <label htmlFor="llm-spend-since">From</label>
            <input id="llm-spend-since" type="date" value={since} onChange={(e) => setSince(e.target.value)} />
          </div>
          <div className="fld">
            <label htmlFor="llm-spend-until">To</label>
            <input id="llm-spend-until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
          </div>
          <button type="submit" className="btn">Show</button>
        </form>

        <QueryView q={q}>
          {(summary) => (
            <>
              <div className="kv" data-testid="llm-spend-total">
                <span className="k">Total</span>
                <span data-testid="llm-spend-total-usd">{usd(summary.totalUsd)}</span>
              </div>
              <div className="kv"><span className="k">Calls</span><span>{summary.calls}</span></div>
              <div className="kv"><span className="k">Tokens</span><span>{summary.promptTokens + summary.completionTokens} ({summary.promptTokens} in · {summary.completionTokens} out)</span></div>

              <h3 className="sh">By team</h3>
              {summary.byTeam.length === 0 ? (
                <p className="faint">Nothing spent in this range.</p>
              ) : (
                <div className="table-wrap">
                  <table className="table" data-testid="llm-spend-by-team">
                    <thead><tr><th scope="col">Team</th><th scope="col">Spent</th><th scope="col">Calls</th></tr></thead>
                    <tbody>
                      {summary.byTeam.map((row) => (
                        <tr key={row.teamId ?? 'none'}>
                          <td data-label="Team">{row.teamId ? (teamName.get(row.teamId) ?? short(row.teamId)) : <span className="faint">the workspace</span>}</td>
                          <td data-label="Spent" className="d-cell">{usd(row.spentUsd)}</td>
                          <td data-label="Calls" className="d-cell">{row.calls}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <h3 className="sh">By bot</h3>
              {summary.byBot.length === 0 ? (
                <p className="faint">Nothing spent in this range.</p>
              ) : (
                <div className="table-wrap">
                  <table className="table" data-testid="llm-spend-by-bot">
                    <thead><tr><th scope="col">Bot</th><th scope="col">Spent</th><th scope="col">Calls</th></tr></thead>
                    <tbody>
                      {summary.byBot.map((row) => (
                        <tr key={`${row.botId ?? 'none'}:${row.purpose ?? ''}`}>
                          <td data-label="Bot" data-testid="llm-spend-bot">
                            {row.botId === null ? <span data-testid="llm-spend-purpose">{purposeLabel(row.purpose)}</span> : <BotCell id={row.botId} name={row.botName} team={row.teamName} rehearsal={row.purpose === 'rehearsal'} />}
                          </td>
                          <td data-label="Spent" className="d-cell">{usd(row.spentUsd)}</td>
                          <td data-label="Calls" className="d-cell">{row.calls}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </QueryView>
      </div>
    </section>
  );
}
