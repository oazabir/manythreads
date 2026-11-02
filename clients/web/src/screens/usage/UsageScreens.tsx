import { useState } from 'react';
import { Link, useParams } from 'react-router';
import type { UsageBotRow, UsageTeamRow } from '@manythreads/shared';
import { fetchBotUsage, fetchTeamUsage, fetchWorkspaceUsage } from '../../api/endpoints';
import { useQuery } from '../../app/useQuery';
import { QueryView } from '../../components/states';
import { count, percent, usd, usdOrHidden } from './format';
import { BudgetBar, DayChart, Headline, Page, QualityPanel, RangePicker, SpendByModel, Updated, type UsageBody } from './UsageReport';

// The three usage pages (PLAN P8-11). Each is the same report for a different subject: the workspace (admins), one team (its members) and one bot.

const DEFAULT_DAYS = 30;

function Charts({ body }: { body: UsageBody }) {
  return (
    <>
      <DayChart id="usage-runs-chart" title="Bot runs per day" days={body.daily} pick={(d) => d.runs} failed={(d) => d.failedRuns} unit="bot runs" format={count} />
      {body.totals.spendUsd !== null ? (
        <DayChart id="usage-spend-chart" title="Model spend per day" days={body.daily} pick={(d) => d.spendUsd ?? 0} unit="dollars of model spend" format={usd} />
      ) : null}
    </>
  );
}

function BotTable({ bots, teamSlug, money }: { bots: UsageBotRow[]; teamSlug?: string; money: boolean }) {
  return (
    <section className="box" aria-labelledby="usage-bots" data-testid="usage-bots">
      <h2 className="box-h" id="usage-bots">Bots</h2>
      {bots.length === 0 ? (
        <p className="faint">No bot did anything in this range.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Bot</th><th scope="col">Runs</th><th scope="col">Failed</th><th scope="col">Tool calls</th><th scope="col">Answers</th>
                {money ? <th scope="col">Spent</th> : null}
              </tr>
            </thead>
            <tbody>
              {bots.map((b) => {
                const team = teamSlug ?? b.teamSlug;
                return (
                  <tr key={b.botId} data-testid="usage-bot-row">
                    <td data-label="Bot">
                      {b.slug !== null && team ? <Link to={`/t/${team}/bots/${b.slug}/usage`}>{b.name ?? b.slug}</Link> : <span className="faint">Removed bot</span>}
                      {teamSlug === undefined && b.teamName ? <span className="faint"> · {b.teamName}</span> : null}
                    </td>
                    <td data-label="Runs" className="d-cell">{count(b.runs)}</td>
                    <td data-label="Failed" className="d-cell">{b.errorRate === null ? '–' : `${count(b.failedRuns)} (${percent(b.errorRate)})`}</td>
                    <td data-label="Tool calls" className="d-cell">{count(b.toolCalls)}</td>
                    <td data-label="Answers" className="d-cell">{count(b.answers)}</td>
                    {money ? <td data-label="Spent" className="d-cell">{usdOrHidden(b.spendUsd)}</td> : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function TeamTable({ teams }: { teams: UsageTeamRow[] }) {
  return (
    <section className="box" aria-labelledby="usage-teams" data-testid="usage-teams">
      <h2 className="box-h" id="usage-teams">Teams</h2>
      {teams.length === 0 ? (
        <p className="faint">No team did anything in this range.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">Team</th><th scope="col">Runs</th><th scope="col">Failed</th><th scope="col">Tool calls</th><th scope="col">Answers</th><th scope="col">Spent</th></tr></thead>
            <tbody>
              {teams.map((t) => (
                <tr key={t.teamId ?? 'none'} data-testid="usage-team-row">
                  <td data-label="Team">{t.slug !== null ? <Link to={`/settings/team/${t.slug}/usage`}>{t.name ?? t.slug}</Link> : <span className="faint">Not tied to a team</span>}</td>
                  <td data-label="Runs" className="d-cell">{count(t.runs)}</td>
                  <td data-label="Failed" className="d-cell">{count(t.failedRuns)}</td>
                  <td data-label="Tool calls" className="d-cell">{count(t.toolCalls)}</td>
                  <td data-label="Answers" className="d-cell">{count(t.answers)}</td>
                  <td data-label="Spent" className="d-cell">{usdOrHidden(t.spendUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function WorkspaceUsage() {
  const [days, setDays] = useState(DEFAULT_DAYS);
  const q = useQuery(`usage:workspace:${days}`, () => fetchWorkspaceUsage(days));
  return (
    <Page
      testId="usage-workspace"
      title="Usage"
      lede="What the bots in this workspace did and what it cost: runs, tool calls, approvals, answers and model spend. Only counts and amounts are kept, never what anyone wrote or read."
    >
      <RangePicker days={days} onPick={setDays} />
      <QueryView q={q}>
        {(b) => (
          <>
            <Headline totals={b.totals} />
            {b.budget ? <BudgetBar budget={b.budget} subject="Workspace" /> : null}
            <Charts body={b} />
            <TeamTable teams={b.teams} />
            <BotTable bots={b.bots} money />
            <SpendByModel rows={b.spendByAlias} />
            <QualityPanel quality={b.quality} title="Answer quality" />
            <section className="box" aria-labelledby="usage-signins" data-testid="usage-signins">
              <h2 className="box-h" id="usage-signins">Sign-ins</h2>
              <div className="kv"><span className="k">Signed in</span><span>{count(b.signIns.ok)}</span></div>
              <div className="kv"><span className="k">Failed attempts</span><span>{count(b.signIns.failed)}</span></div>
              {b.signIns.byMethod.map((m) => (
                <div className="kv" key={m.method}><span className="k">By {m.method}</span><span>{count(m.count)}</span></div>
              ))}
            </section>
            <Updated at={b.generatedAt} onRefresh={q.reload} />
          </>
        )}
      </QueryView>
    </Page>
  );
}

export function TeamUsage() {
  const { slug = '' } = useParams();
  const [days, setDays] = useState(DEFAULT_DAYS);
  const q = useQuery(`usage:team:${slug}:${days}`, () => fetchTeamUsage(slug, days));
  return (
    <Page
      testId="usage-team"
      title="Team usage"
      lede="What this team's bots did: runs, tool calls, approvals and answers. Money is shown to workspace admins only. Only counts are kept, never what anyone wrote or read."
    >
      <RangePicker days={days} onPick={setDays} />
      <QueryView q={q}>
        {(b) => (
          <>
            <Headline totals={b.totals} />
            {b.budget ? <BudgetBar budget={b.budget} subject={b.team.name} /> : null}
            <Charts body={b} />
            <BotTable bots={b.bots} teamSlug={b.team.slug} money={b.totals.spendUsd !== null} />
            <SpendByModel rows={b.spendByAlias} />
            <QualityPanel
              quality={b.quality}
              title="Brain quality"
              hint={b.brainSlug ? undefined : 'This team has no Brain bot, so these numbers cover all of its answers.'}
            />
            <Updated at={b.generatedAt} onRefresh={q.reload} />
          </>
        )}
      </QueryView>
    </Page>
  );
}

export function BotUsage() {
  const { team = '', botSlug = '' } = useParams();
  const [days, setDays] = useState(DEFAULT_DAYS);
  const q = useQuery(`usage:bot:${team}:${botSlug}:${days}`, () => fetchBotUsage(team, botSlug, days));
  return (
    <Page
      testId="usage-bot"
      title={q.status === 'ok' ? `${q.data.bot.name} usage` : 'Bot usage'}
      lede="What this bot did: runs, tool calls, approvals and answers. Money is shown to workspace admins only. Only counts are kept, never what anyone wrote or read."
    >
      <p className="d">
        <Link to={`/t/${team}/bots/${botSlug}`}>Back to the bot</Link>
      </p>
      <RangePicker days={days} onPick={setDays} />
      <QueryView q={q}>
        {(b) => (
          <>
            <Headline totals={b.totals} />
            {b.budget ? <BudgetBar budget={b.budget} subject={b.bot.name} /> : null}
            <Charts body={b} />
            <SpendByModel rows={b.spendByAlias} />
            <QualityPanel quality={b.quality} title="Answer quality" />
            <Updated at={b.generatedAt} onRefresh={q.reload} />
          </>
        )}
      </QueryView>
    </Page>
  );
}
