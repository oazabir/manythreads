import { fetchOpsHealth } from '../../api/endpoints';
import { useQuery } from '../../app/useQuery';
import { QueryView } from '../../components/states';
import { checkStatus, formatBytes, formatCheckValue, formatLimit, formatSeconds, volumeTitle } from './format';

/**
 * Settings, System health. Read-only: the numbers the server also hands to a monitoring system at `/metrics`, and the verdict of each check
 * against its limit. The limits come from the server's environment (docs/deploy/monitoring.md); workspace owners and admins get a mail when a
 * check trips and when it clears.
 */
export function SystemHealth() {
  const q = useQuery('ops-health', fetchOpsHealth);
  return (
    <div className="health-page" data-landmark="health">
      <h1 className="pane-title" data-landmark="title">System health</h1>
      <p className="lede" data-landmark="lede">
        How the server is doing right now: whether work is piling up, whether the bots have room to run, and whether the disks are filling.
        When a number passes its limit, workspace admins get one mail, and one more when it is back to normal.
      </p>
      <QueryView q={q}>
        {({ snapshot: s, checks }) => (
          <>
            <section className="box" aria-labelledby="health-checks" data-landmark="health-checks">
              <h2 className="box-h" id="health-checks">Checks <span className="push"><button type="button" className="btn" onClick={q.reload}>Refresh</button></span></h2>
              {checks.map((c) => {
                const st = checkStatus(c);
                return (
                  <div className="health-row" key={c.name} data-check={c.name} data-status={st.tone}>
                    <div><span className={`health-st ${st.tone}`}>{st.word}</span></div>
                    <div>
                      <div>{c.label}</div>
                      <div className="d" data-vt-mask>
                        {formatCheckValue(c)} (limit {formatLimit(c)}){c.since ? ` · since ${new Date(c.since).toLocaleString()}` : ''}
                      </div>
                    </div>
                  </div>
                );
              })}
            </section>

            <section className="box" aria-labelledby="health-numbers" data-landmark="health-numbers">
              <h2 className="box-h" id="health-numbers">Numbers</h2>
              <div className="health-kvs" data-vt-mask>
                {s.outbox ? <Row k="Events waiting to be passed on" v={`${s.outbox.backlog} (oldest ${formatSeconds(s.outbox.oldestAgeSeconds)}, ${s.outbox.retrying} retrying)`} /> : null}
                {s.jobs ? <Row k="Background jobs waiting" v={`${s.jobs.ready} (oldest ${formatSeconds(s.jobs.oldestReadyAgeSeconds)}), ${s.jobs.running} running, ${s.jobs.dead} given up on`} /> : null}
                {s.runs ? <Row k="Bot run slots" v={`${s.runs.slotsUsed} of ${s.runs.slotsLimit} in use, ${s.runs.queued} waiting`} /> : null}
                {s.approvals ? <Row k="Approvals waiting" v={`${s.approvals.pending} (oldest ${formatSeconds(s.approvals.oldestPendingAgeSeconds)})`} /> : null}
                {s.budgets ? <Row k="Model budgets" v={`${s.budgets.limits} with a dollar cap, ${s.budgets.nearLimit} at 80 % or more, ${s.budgets.exhausted} used up`} /> : null}
                {s.database ? <Row k="Database connections" v={`${s.database.connectionsUsed} of ${s.database.connectionsMax}`} /> : null}
                <Row k="Server memory" v={`${formatBytes(s.process.residentBytes)} in use`} />
                <Row k="Event loop delay" v={`${Math.round(s.process.eventLoopLagP99Seconds * 1000)} ms (99th percentile)`} />
                <Row k="Server running for" v={formatSeconds(s.process.uptimeSeconds)} />
              </div>
            </section>

            <section className="box" aria-labelledby="health-volumes" data-landmark="health-volumes">
              <h2 className="box-h" id="health-volumes">Storage</h2>
              {s.volumes.length === 0 ? (
                <p className="fld-hint">No volume is measured on this server.</p>
              ) : (
                s.volumes.map((v) => (
                  <div className="health-row" key={v.name} data-volume={v.name}>
                    <div className="health-pct" data-vt-mask>{Math.round(v.usedPercent)} %</div>
                    <div>
                      <div>{volumeTitle(v)}</div>
                      <div className="d" data-vt-mask>{formatBytes(v.freeBytes)} free of {formatBytes(v.totalBytes)}</div>
                    </div>
                  </div>
                ))
              )}
            </section>
          </>
        )}
      </QueryView>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="kv"><span className="k">{k}</span><span>{v}</span></div>
  );
}
