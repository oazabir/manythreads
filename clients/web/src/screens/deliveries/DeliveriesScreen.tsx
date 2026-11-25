import { Link } from 'react-router';
import { useState } from 'react';
import { deliveriesRoute, DeliveriesResponse, type Delivery } from '@manythreads/shared';
import { call } from '../../api/client';
import { useQuery } from '../../app/useQuery';
import { PageHeader } from '../../components/PageHeader';
import { SkeletonRows } from '../../components/Skeleton';
import { useShell } from '../../shell/context';

/*
 * The delivery dashboard (P35-05): each thread where the team's bots delivered work (a card per delivery) in the chosen window, with how long it took, how many runs it needed
 * and how many failed, its cards and pull requests, the approvals it raised and the people's nudges; then the window per bot. Spend shows for a workspace
 * admin; a run on a Claude or Codex subscription has no spend line, so its run time is what it cost.
 */

const fetchDeliveries = (slug: string, days: number) => call(deliveriesRoute, { response: DeliveriesResponse }, { days: String(days) }, { slug });
const DAYS = [7, 14, 30] as const;

const money = (v: number | null): string => (v === null ? '—' : `$${v.toFixed(2)}`);
const took = (m: number | null): string => (m === null ? 'open' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`);

function Fact({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'warn' }) {
  return (
    <div className="dl-fact">
      <dt>{label}</dt>
      <dd className={tone === 'warn' ? 'dl-warn' : undefined}>
        {value}
        {sub ? <span className="dl-sub">{sub}</span> : null}
      </dd>
    </div>
  );
}

/* one delivery as a card: the title is the one link, the rest is quiet facts, with a pill only for what needs a look (failed runs, the pull requests) */
function Row({ d, slug }: { d: Delivery; slug: string }) {
  return (
    <li className="dl-card" data-testid="delivery-row" data-root={d.rootId}>
      <div className="dl-head">
        <Link className="dl-title" to={`/t/${encodeURIComponent(slug)}/threads?thread=${d.rootId}`}>
          {d.title || 'Untitled request'}
        </Link>
        <span className="dl-sub">
          #{d.channelName} · {new Date(d.startedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · {d.bots.join(', ')}
        </span>
      </div>
      {d.failedRuns > 0 || d.pullRequests.length > 0 ? (
        <div className="dl-pills">
          {d.failedRuns > 0 ? <span className="dl-pill" data-tone="bad">{d.failedRuns} failed</span> : null}
          {d.pullRequests.map((p) =>
            p.url ? (
              <a key={p.number} className="dl-pill" data-state={p.state} href={p.url} target="_blank" rel="noopener noreferrer">
                PR #{p.number} · {p.state}
              </a>
            ) : (
              <span key={p.number} className="dl-pill" data-state={p.state}>
                PR #{p.number} · {p.state}
              </span>
            ),
          )}
        </div>
      ) : null}
      <dl className="dl-facts">
        <Fact label="Took" value={took(d.minutes)} />
        <Fact label="Runs" value={String(d.runs)} sub={`${d.runMinutes} min of runs`} />
        <Fact label="Cards done" value={`${d.doneCards}/${d.cards}`} />
        <Fact label="Approvals" value={String(d.approvals)} />
        <Fact label="Nudges" value={String(d.nudges)} tone={d.nudges > 0 ? 'warn' : undefined} />
        <Fact label="Spend" value={money(d.spendUsd)} />
      </dl>
    </li>
  );
}

export function DeliveriesScreen() {
  const { team } = useShell();
  const slug = team?.slug ?? '';
  const [days, setDays] = useState<number>(7);
  const q = useQuery(`deliveries:${slug}:${days}`, () => fetchDeliveries(slug, days));
  const data = q.status === 'ok' ? q.data : null;
  return (
    <div className="dl-screen" data-testid="deliveries">
      <PageHeader
        title="Deliveries"
        description={data ? `${data.deliveries.length} in the last ${days} days` : undefined}
        actions={
          <div className="tabs2" role="tablist" aria-label="Window">
            {DAYS.map((n) => (
              <button key={n} type="button" role="tab" aria-selected={days === n} className={days === n ? 'on' : ''} onClick={() => setDays(n)} data-testid={`deliveries-days-${n}`}>
                {n} days
              </button>
            ))}
          </div>
        }
      />
      <div className="dl-body">
        {q.status === 'loading' ? <SkeletonRows rows={5} label="Loading deliveries" /> : null}
        {q.status === 'error' ? (
          <p className="view-empty-title" role="alert">
            The deliveries could not be loaded.
          </p>
        ) : null}
        {data && data.deliveries.length === 0 ? <p className="dl-empty">No bot delivered anything in this window.</p> : null}
        {data && data.deliveries.length > 0 ? (
          <ul className="dl-list" aria-label="Deliveries">
            {data.deliveries.map((d) => (
              <Row key={d.rootId} d={d} slug={slug} />
            ))}
          </ul>
        ) : null}
        {data && data.bots.length > 0 ? (
          <>
            <h2 className="dl-h">Bots, last {days} days</h2>
            <div className="dl-tablewrap">
              <table className="dl-table" aria-label="Bots">
                <thead>
                  <tr>
                    <th scope="col">Bot</th>
                    <th scope="col" title="The runner its definition names now">
                      Runner
                    </th>
                    <th scope="col">Runs</th>
                    <th scope="col">Failed</th>
                    <th scope="col">Average run</th>
                    <th scope="col">Spend</th>
                  </tr>
                </thead>
                <tbody>
                  {data.bots.map((b) => (
                    <tr key={b.slug} data-testid="delivery-bot" data-bot={b.slug}>
                      <td>{b.name}</td>
                      <td>{b.runner ?? 'the team default'}</td>
                      <td>{b.runs}</td>
                      <td className={b.failedRuns > 0 ? 'dl-bad' : ''}>{b.failedRuns}</td>
                      <td>{b.avgMinutes} min</td>
                      <td>{money(b.spendUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
