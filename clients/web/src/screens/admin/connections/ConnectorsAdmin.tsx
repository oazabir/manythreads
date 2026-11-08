import type { ConnectorHealthRow } from '@manythreads/shared';
import { isApiError } from '../../../api/client';
import { useQuery } from '../../../app/useQuery';
import { EmptyState, QueryView } from '../../../components/states';
import { fetchBridgesHealth, fetchConnectionsHealth, fetchConnectorSourcesHealth, fetchProviderEndpointsHealth } from '../../connections/api';
import { AREAS, connectorName, lastDayLine, refusedLine, type Area } from './words';

/*
 * The "Connectors" tab of `/settings/workspace/connections` (PLAN Bundle D, P16-11, decision D31): per service, how many people are connected, who has to sign in again, and how
 * many calls worked this week. Each plugin answers its own route with rows of one shape; this page puts them together. A plugin that is not installed answers 404 and is left
 * out. Counts and states only: never an account address, a token or what a call read.
 */

type Loaded = { rows: ConnectorHealthRow[]; unavailable: Area[] };

const LOADERS: ReadonlyArray<readonly [Area, () => Promise<{ rows: ConnectorHealthRow[] }>]> = [
  ['connections', fetchConnectionsHealth],
  ['webhooks', fetchProviderEndpointsHealth],
  ['knowledge', fetchConnectorSourcesHealth],
  ['bridges', fetchBridgesHealth],
];

async function loadAll(): Promise<Loaded> {
  const settled = await Promise.allSettled(LOADERS.map(([, load]) => load()));
  const rows: ConnectorHealthRow[] = [];
  const unavailable: Area[] = [];
  let firstError: unknown;
  settled.forEach((s, i) => {
    const area = LOADERS[i]![0];
    if (s.status === 'fulfilled') {
      rows.push(...s.value.rows);
      return;
    }
    // not allowed is the same answer for every area: show it once for the whole page
    if (isApiError(s.reason) && s.reason.status === 403) firstError ??= s.reason;
    // an area whose plugin is not installed answers 404 and is simply not shown
    else if (!(isApiError(s.reason) && s.reason.status === 404)) unavailable.push(area);
  });
  if (firstError) throw firstError;
  return { rows, unavailable };
}

export function ConnectorsAdmin() {
  const q = useQuery('connectors-health', loadAll);
  return (
    <QueryView q={q}>
      {({ rows, unavailable }) => (
        <div className="ac-connectors" data-testid="connectors-admin">
          <p className="ac-lede">What is connected, how often bots used it in the last 7 days, and where people have to sign in again. Only counts are shown, never an account or what a bot read.</p>
          {rows.length === 0 && unavailable.length > 0 ? null : rows.length === 0 ? (
            <EmptyState title="Nothing is connected yet">Once people connect their accounts, or a team adds a connection, each service shows up here.</EmptyState>
          ) : (
            AREAS.map((a) => {
              const mine = rows.filter((r) => r.area === a.area);
              return mine.length === 0 ? null : <AreaTable key={a.area} spec={a} rows={mine} />;
            })
          )}
          {unavailable.length > 0 ? (
            <p className="ac-note" role="status" data-testid="connectors-partial">
              Some figures could not be loaded ({unavailable.map((u) => AREAS.find((a) => a.area === u)?.title.toLowerCase() ?? u).join(', ')}).{' '}
              <button type="button" className="ac-link" onClick={q.reload}>Try again</button>
            </p>
          ) : null}
        </div>
      )}
    </QueryView>
  );
}

function AreaTable({ spec, rows }: { spec: (typeof AREAS)[number]; rows: ConnectorHealthRow[] }) {
  return (
    <section className="ac-area" aria-labelledby={`ac-area-${spec.area}`} data-testid={`connectors-${spec.area}`}>
      <h2 className="ac-h" id={`ac-area-${spec.area}`}>{spec.title}</h2>
      <div className="block ac-wrap">
        <table className="table ac-table">
          <thead>
            <tr>
              <th scope="col">Service</th>
              <th scope="col">{spec.people}</th>
              {spec.shared ? <th scope="col">{spec.shared}</th> : null}
              {spec.area === 'connections' ? <th scope="col">Sign in again</th> : null}
              <th scope="col">{spec.calls}</th>
              <th scope="col">{spec.failures}</th>
              <th scope="col">Last used</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const refused = refusedLine(r.refused7d);
              return (
                <tr key={`${r.area}:${r.connector}`} data-testid="connector-row" data-connector={r.connector}>
                  <td data-label="Service" className="ac-c">
                    <strong>{connectorName(r.connector)}</strong>
                    {r.problem ? <div className="ac-problem" data-testid="connector-problem"><span aria-hidden="true">! </span>{r.problem}</div> : null}
                    {refused ? <div className="ac-sub">Refused: {refused}</div> : null}
                  </td>
                  <td data-label={spec.people} className="ac-c ac-n">{r.people}</td>
                  {spec.shared ? <td data-label={spec.shared} className="ac-c ac-n">{r.shared}</td> : null}
                  {spec.area === 'connections' ? <td data-label="Sign in again" className={`ac-c ac-n${r.needsReconnect > 0 ? ' ac-warn' : ''}`}>{r.needsReconnect}</td> : null}
                  <td data-label={spec.calls} className="ac-c ac-n">{r.calls7d}</td>
                  <td data-label={spec.failures} className={`ac-c ac-n${r.failures7d > 0 && r.failures7d * 2 > r.calls7d ? ' ac-warn' : ''}`}>{r.failures7d}</td>
                  <td data-label="Last used" className="ac-c ac-d">{lastDayLine(r.lastUsedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
