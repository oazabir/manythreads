import { useState } from 'react';
import { TEAM_EGRESS_HOSTS_MAX, type ListTeamEgressResponse, type TeamEgress } from '@manythreads/shared';
import { isApiError } from '../../api/client';
import { saveTeamEgress } from '../../api/endpoints';
import { Alert, Notice, Toggle } from '../../components/ui';
import { hostsFromText, hostsToText, proxyFromText, teamEgressSummary } from './format';

/** The other half of the page: for each team, the web hosts its bots may reach and an optional proxy. */
export function EgressSection({ data, reload }: { data: ListTeamEgressResponse; reload: () => void }) {
  return (
    <section className="block" aria-labelledby="gr-egress" data-testid="gr-egress">
      <h2 className="bh" id="gr-egress">Which hosts each team&rsquo;s bots may reach</h2>
      <div className="block-body">
        <p className="fld-hint">
          Save the web hosts a team&rsquo;s bots are meant to reach, plus the workspace list{data.workspaceHosts.length > 0 ? ` (${data.workspaceHosts.join(', ')})` : ' (empty)'}.
          The list is stored and checked whenever something sends a request on a team&rsquo;s behalf with the limit switched on. Today no built-in tool does that, so
          switching it on does not yet stop anything: the list is ready for when one does.
          Model providers such as OpenAI and Anthropic cannot be listed here: calls to a model follow the workspace&rsquo;s model settings, so a team list can never be a way round them.
        </p>
        {data.teams.length === 0 ? <p className="fld-hint">There are no teams yet.</p> : null}
        <ul className="rows">
          {data.teams.map((t) => (
            <TeamRow key={t.teamId} team={t} reload={reload} />
          ))}
        </ul>
      </div>
    </section>
  );
}

function TeamRow({ team, reload }: { team: TeamEgress; reload: () => void }) {
  const [enforce, setEnforce] = useState(team.enforce);
  const [hosts, setHosts] = useState(hostsToText(team.hosts));
  const [proxy, setProxy] = useState(team.proxyUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const list = hostsFromText(hosts);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const saved = await saveTeamEgress(team.teamId, { enforce, hosts: list, proxyUrl: proxyFromText(proxy) });
      setHosts(hostsToText(saved.team.hosts));
      setNote(`Saved for ${team.teamName}.`);
      reload();
    } catch (err) {
      setError(isApiError(err) ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="gr-team" data-team={team.teamName}>
      <div className="srow">
        <div>
          <div><b data-vt-mask>{team.teamName}</b></div>
          <div className="d">{teamEgressSummary(team.enforce, team.hosts.length)}</div>
        </div>
        <Toggle label={`Limit ${team.teamName} to the listed hosts`} checked={enforce} disabled={busy} onChange={setEnforce} />
      </div>
      {error ? <Alert>{error}</Alert> : null}
      {note ? <Notice>{note}</Notice> : null}
      <div className="fld">
        <label htmlFor={`gr-hosts-${team.teamId}`}>Hosts this team may reach</label>
        <textarea id={`gr-hosts-${team.teamId}`} rows={3} value={hosts} placeholder={'api.github.com\nregistry.npmjs.org'} onChange={(e) => setHosts(e.target.value)} />
        <div className="fld-hint">One per line. Write a name like api.example.com; a web address is shortened to its host. At most {TEAM_EGRESS_HOSTS_MAX}.</div>
      </div>
      <div className="fld">
        <label htmlFor={`gr-proxy-${team.teamId}`}>Proxy (optional)</label>
        <input id={`gr-proxy-${team.teamId}`} value={proxy} placeholder="http://proxy.internal:3128" onChange={(e) => setProxy(e.target.value)} />
        <div className="fld-hint">Where this team&rsquo;s outgoing requests are meant to go through. Leave out any user name or password.</div>
      </div>
      <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>Save for {team.teamName}</button>
    </li>
  );
}
