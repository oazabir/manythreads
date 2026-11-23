import { Link } from 'react-router';
import { useState } from 'react';
import { deliveriesRoute, DeliveriesResponse, type Delivery } from '@manythreads/shared';
import { call } from '../../api/client';
import { useQuery } from '../../app/useQuery';
import { PageHeader } from '../../components/PageHeader';
import { SkeletonRows } from '../../components/Skeleton';
import { useShell } from '../../shell/context';

/*
 * The delivery dashboard (P35-05): each thread where the team's bots delivered work in the chosen window, with how long it took, how many runs it needed
 * and how many failed, its cards and pull requests, the approvals it raised and the people's nudges; then the window per bot. Spend shows for a workspace
 * admin; a run on a Claude or Codex subscription has no spend line, so its run time is what it cost.
 */

const fetchDeliveries = (slug: string, days: number) => call(deliveriesRoute, { response: DeliveriesResponse }, { days: String(days) }, { slug });
const DAYS = [7, 14, 30] as const;

const money = (v: number | null): string => (v === null ? '—' : `$${v.toFixed(2)}`);
const took = (m: number | null): string => (m === null ? 'open' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`);

function Row({ d, slug }: { d: Delivery; slug: string }) {
  return (
    <tr data-testid="delivery-row" data-root={d.rootId}>
      <td className="dl-title">
        <Link to={`/t/${encodeURIComponent(slug)}/threads?thread=${d.rootId}`}>{d.title || 'Untitled request'}</Link>
        <span className="dl-sub">
          #{d.channelName} · {new Date(d.startedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · {d.bots.join(', ')}
        </span>
      </td>
      <td>{took(d.minutes)}</td>
      <td>
        {d.runs}
        {d.failedRuns > 0 ? <span className="dl-bad"> · {d.failedRuns} failed</span> : null}
        <span className="dl-sub">{d.runMinutes} min of runs</span>
      </td>
      <td>
        {d.doneCards}/{d.cards}
      </td>
      <td>
        {d.pullRequests.length === 0
          ? '—'
          : d.pullRequests.map((p) => (
              <span key={p.number} className="dl-pr" data-state={p.state}>
                {p.url ? (
                  <a href={p.url} target="_blank" rel="noopener noreferrer">
                    #{p.number}
                  </a>
                ) : (
                  `#${p.number}`
                )}{' '}
                {p.state}
              </span>
            ))}
      </td>
      <td>{d.approvals}</td>
      <td className={d.nudges > 0 ? 'dl-warn' : ''}>{d.nudges}</td>
      <td>{money(d.spendUsd)}</td>
    </tr>
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
          <table className="dl-table" aria-label="Deliveries">
            <thead>
              <tr>
                <th scope="col">Request</th>
                <th scope="col">Took</th>
                <th scope="col">Runs</th>
                <th scope="col">Cards done</th>
                <th scope="col">Pull requests</th>
                <th scope="col">Approvals</th>
                <th scope="col" title="People's replies after the request">
                  Nudges
                </th>
                <th scope="col">Spend</th>
              </tr>
            </thead>
            <tbody>
              {data.deliveries.map((d) => (
                <Row key={d.rootId} d={d} slug={slug} />
              ))}
            </tbody>
          </table>
        ) : null}
        {data && data.bots.length > 0 ? (
          <>
            <h2 className="dl-h">Bots, last {days} days</h2>
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
          </>
        ) : null}
      </div>
    </div>
  );
}
