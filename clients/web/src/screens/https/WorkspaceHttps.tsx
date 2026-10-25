import { fetchWorkspaceHttps } from '../../api/endpoints';
import { useQuery } from '../../app/useQuery';
import { QueryView } from '../../components/states';
import { appHostPattern, CHECK_TITLES, describeMode, statusWord, switchOptions } from './commands';

/**
 * Settings, Domain & HTTPS (onboarding step 4). Read-only: the HTTPS mode is chosen when the cluster is deployed, so this
 * page shows what is set, runs live checks, and hands the admin the deploy command that switches to another mode.
 */
export function WorkspaceHttps() {
  const q = useQuery('workspace-https', fetchWorkspaceHttps);
  return (
    <div className="https-page" data-landmark="https">
      <h1 className="pane-title" data-landmark="title">Domain &amp; HTTPS</h1>
      <p className="lede" data-landmark="lede">
        How people reach this workspace, and whether the secure padlock works. With a Cloudflare proxy, Cloudflare serves visitors and
        this cluster only talks to Cloudflare. With Let&apos;s Encrypt, this cluster gets its own certificate and serves visitors directly.
      </p>
      <QueryView q={q}>
        {(h) => {
          const pattern = appHostPattern(h.appsDomain);
          return (
            <>
              <section className="box" aria-labelledby="https-now" data-landmark="https-now">
                <h2 className="box-h" id="https-now">Current setup</h2>
                <p className="https-mode">{describeMode(h)}</p>
                <div className="fld"><span className="fld-label">Domain</span><div className="inp-static mono">{h.domain ?? 'not a valid address'}</div></div>
                <div className="fld">
                  <span className="fld-label">App addresses</span>
                  <div className="inp-static mono">{pattern ?? 'apps have no domain of their own'}</div>
                </div>
                <div className="fld-hint" data-vt-mask>We see you as <span className="mono">{h.seenAs.clientIp}</span>{h.seenAs.viaCloudflare ? ' (through Cloudflare).' : '.'}</div>
              </section>
              <section className="box" aria-labelledby="https-checks" data-landmark="https-checks">
                <h2 className="box-h" id="https-checks">Checks <span className="push"><button type="button" className="btn" onClick={q.reload}>Run again</button></span></h2>
                {h.checks.map((c) => (
                  <div className="https-row" key={c.id} data-check={c.id} data-status={c.status}>
                    <div><span className={`https-st ${c.status}`}>{statusWord(c.status)}</span></div>
                    <div>
                      <div>{CHECK_TITLES[c.id]}</div>
                      <div className="d" data-vt-mask>{c.detail}</div>
                    </div>
                  </div>
                ))}
              </section>
              <section className="box" aria-labelledby="https-switch" data-landmark="https-switch">
                <h2 className="box-h" id="https-switch">Switch to another mode</h2>
                <p className="fld-hint">Run one of these on the machine you deploy from. The workspace restarts briefly. Replace the example file names and email with yours.</p>
                {switchOptions(h).map((o) => (
                  <div className="https-opt" key={o.id} data-option={o.id}>
                    <div>{o.title}</div>
                    <div className="d">{o.summary}</div>
                    <pre className="https-cmd mono">{o.command}</pre>
                  </div>
                ))}
              </section>
            </>
          );
        }}
      </QueryView>
    </div>
  );
}
