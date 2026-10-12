import { useState, type FormEvent } from 'react';
import type { BotSummary, LlmBudgetWindow, LlmLimit, LlmLimitScope, ListBotsResponse, TeamSummary } from '@manythreads/shared';
import { isApiError } from '../../../api/client';
import { deleteLlmLimit, setLlmLimit } from '../../../api/endpoints';
import { useQuery } from '../../../app/useQuery';
import { Alert, Notice, Time, Field } from '../../../components/ui';
import { fetchBots } from '../../bots/api';

/*
 * Workspace → LLM → Budgets and rate limits (SPEC §10.1, PLAN P5-07/P5-08). A call must pass every scope that applies
 * to it — the workspace and its team, then the bot and its session — so setting a workspace cap does not stop a team
 * from having a tighter one, and the refusal a run sees names the narrowest scope that ran out.
 *
 * One row per target: saving the workspace budget twice changes it rather than adding a second one, which is why the
 * form is the same for "set" and "change" and there is no separate edit button.
 *
 * The bot names come from the teams' rosters (`/api/teams/:slug/bots`), which is a read a member may make; the LLM
 * routes themselves stay admin-only. A server without the bots plugin answers 404 there, and the section then lists bot
 * limits by id instead of breaking the page — the same feature-detect the sidebar does for its channel list.
 */

const SCOPES: ReadonlyArray<{ value: LlmLimitScope; label: string }> = [
  { value: 'workspace', label: 'Workspace' },
  { value: 'team', label: 'Team' },
  { value: 'bot', label: 'Bot' },
  { value: 'session', label: 'Session' },
];

const SCOPE_NOUN: Record<LlmLimitScope, string> = { workspace: 'workspace', team: 'team', bot: 'bot', session: 'session' };

const usd = (n: number) => `$${n.toFixed(2)}`;
const short = (id: string) => `${id.slice(0, 8)}…`;

export function LimitsSection({ limits, teams, reload }: { limits: LlmLimit[]; teams: TeamSummary[]; reload: () => void }) {
  const [scope, setScope] = useState<LlmLimitScope>('workspace');
  const [teamId, setTeamId] = useState('');
  const [botId, setBotId] = useState('');
  const [window, setWindow] = useState<LlmBudgetWindow>('month');
  const [budget, setBudget] = useState('');
  const [rate, setRate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Each team's roster, kept per team so the bot picker only ever offers a bot of the chosen team.
  const teamSlugs = teams.map((t) => t.slug).join(',');
  const botsQ = useQuery(`llm-bots:${teamSlugs}`, async () => {
    const lists: ListBotsResponse[] = await Promise.all(
      teams.map((t) => fetchBots(t.slug).catch(() => ({ bots: [] as BotSummary[] }))),
    );
    const byTeam: Record<string, BotSummary[]> = {};
    teams.forEach((t, i) => {
      byTeam[t.slug] = lists[i]?.bots ?? [];
    });
    return byTeam;
  });
  const botsByTeam = botsQ.status === 'ok' ? botsQ.data : {};
  const botName = new Map(Object.values(botsByTeam).flat().map((b) => [b.id, b.name]));
  // Keyed by the plain id string: the entity brands it as TeamId, the ledger's rows carry it unbranded.
  const teamName = new Map(teams.map((t) => [t.id as string, t.name]));

  const chosenTeam = teams.find((t) => (t.id as string) === teamId);
  const teamBots = chosenTeam ? (botsByTeam[chosenTeam.slug] ?? []) : [];
  const needsTeam = scope !== 'workspace';
  const needsBot = scope === 'bot' || scope === 'session';

  function target(row: LlmLimit): string {
    if (row.scope === 'workspace') return 'the whole workspace';
    if (row.scope === 'team') return (row.teamId && teamName.get(row.teamId)) ?? (row.teamId ? short(row.teamId) : 'a deleted team');
    return (row.botId && botName.get(row.botId)) ?? (row.botId ? short(row.botId) : 'a deleted bot');
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNote(null);

    const budgetRaw = budget.trim();
    const rateRaw = rate.trim();
    if (budgetRaw !== '' && !Number.isFinite(Number(budgetRaw))) return setError('The budget must be a number of dollars.');
    if (rateRaw !== '' && !Number.isInteger(Number(rateRaw))) return setError('The rate limit must be a whole number of calls.');
    const limitUsd = budgetRaw === '' ? null : Number(budgetRaw);
    const requestsPerMinute = rateRaw === '' ? null : Number(rateRaw);
    if (limitUsd === null && requestsPerMinute === null) return setError('A limit needs a budget, a rate limit, or both.');
    if (needsTeam && !teamId) return setError('Choose the team this limit applies to.');
    if (needsBot && !botId) return setError('Choose the bot this limit applies to.');

    setBusy(true);
    try {
      await setLlmLimit({
        scope,
        window,
        limitUsd,
        requestsPerMinute,
        ...(scope === 'team' ? { teamId } : {}),
        ...(needsBot ? { botId } : {}),
      });
      setNote(`The ${SCOPE_NOUN[scope]} limit is saved.`);
      setBudget('');
      setRate('');
      reload();
    } catch (err) {
      setError(isApiError(err) ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: LlmLimit) {
    setError(null);
    setNote(null);
    try {
      await deleteLlmLimit(row.id);
      setNote(`The ${SCOPE_NOUN[row.scope]} limit is removed.`);
      reload();
    } catch (err) {
      setError(isApiError(err) ? err.message : 'Something went wrong. Try again.');
    }
  }

  return (
    <section className="block" aria-labelledby="llm-limits">
      <h2 className="bh" id="llm-limits">Budgets and rate limits</h2>
      <div className="block-body">
        <p className="lede">
          A ceiling on what the models may cost. Every scope that applies is checked before a call leaves, narrowest
          first, so a bot’s own budget runs out before the workspace’s does.
        </p>
        {error ? <Alert>{error}</Alert> : null}
        {note ? <Notice>{note}</Notice> : null}

        {limits.length === 0 ? (
          <p className="faint" data-testid="llm-no-limits">No limit is set. Calls are unlimited except by what the providers charge.</p>
        ) : (
          <div className="table-wrap">
            <table className="table" data-testid="llm-limits">
              <thead>
                <tr>
                  <th scope="col">Scope</th>
                  <th scope="col">Applies to</th>
                  <th scope="col">Window</th>
                  <th scope="col">Budget</th>
                  <th scope="col">Rate</th>
                  <th scope="col"><span className="faint">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {limits.map((row) => (
                  <tr key={row.id} data-scope={row.scope}>
                    <td data-label="Scope"><span className="kind h">{SCOPE_NOUN[row.scope]}</span></td>
                    <td data-label="Applies to">{target(row)}</td>
                    <td data-label="Window" className="d-cell">{row.scope === 'session' ? <span className="faint">the whole session</span> : row.window}</td>
                    <td data-label="Budget" className="d-cell">{row.limitUsd === null ? <span className="faint">none</span> : usd(row.limitUsd)}</td>
                    <td data-label="Rate" className="d-cell">{row.requestsPerMinute === null ? <span className="faint">none</span> : `${row.requestsPerMinute} a minute`}</td>
                    <td data-label="Actions" className="d-cell">
                      <button type="button" className="btn" onClick={() => void remove(row)}>Remove</button>
                      <span className="faint"> · <Time iso={row.updatedAt} /></span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <form className="stack-form" onSubmit={submit} noValidate data-testid="llm-set-limit">
          <h3 className="sh">Set a limit</h3>
          <div className="form-grid">
            <div className="fld">
              <label htmlFor="llm-scope">Scope</label>
              <select id="llm-scope" value={scope} onChange={(e) => setScope(e.target.value as LlmLimitScope)}>
                {SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>

            {needsTeam ? (
              <div className="fld">
                <label htmlFor="llm-limit-team">Team</label>
                <select
                  id="llm-limit-team"
                  value={teamId}
                  onChange={(e) => {
                    setTeamId(e.target.value);
                    setBotId('');
                  }}
                >
                  <option value="">Choose a team…</option>
                  {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
            ) : null}

            {needsBot ? (
              <div className="fld">
                <label htmlFor="llm-limit-bot">Bot</label>
                <select id="llm-limit-bot" value={botId} onChange={(e) => setBotId(e.target.value)} disabled={!teamId}>
                  <option value="">{teamId ? 'Choose a bot…' : 'Choose a team first'}</option>
                  {teamBots.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
            ) : null}

            <div className="fld">
              <label htmlFor="llm-window">Window</label>
              <select id="llm-window" value={window} onChange={(e) => setWindow(e.target.value as LlmBudgetWindow)} disabled={scope === 'session'}>
                <option value="month">A month</option>
                <option value="day">A day</option>
              </select>
              {scope === 'session' ? <div className="fld-hint">A session budget covers the session from its first call.</div> : null}
            </div>

            <Field label="Budget (USD)" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="50" hint="Leave empty for a rate limit only." />
            <Field label="Calls a minute" inputMode="numeric" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="60" hint="Leave empty for a budget only." />
          </div>
          <button type="submit" className="btn primary" disabled={busy}>Set limit</button>
        </form>
      </div>
    </section>
  );
}
