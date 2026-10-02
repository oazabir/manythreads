import { useState, type FormEvent } from 'react';
import { isApiError } from '../api/client';
import { fetchTeamTags, fetchTeams, fetchWorkspace, fetchWorkspaceMembers, updateWorkspace } from '../api/endpoints';
import { useSession, useSessionState } from '../app/session';
import { useQuery } from '../app/useQuery';
import { QueryView } from '../components/states';
import { Alert, Field, Notice, Time, Toggle } from '../components/ui';
import type { UpdateWorkspaceRequest, WorkspaceSettings } from '@manythreads/shared';

export function WorkspaceGeneral() {
  const session = useSession();
  const { setSession } = useSessionState();
  const q = useQuery('workspace-summary', async () => {
    const [members, teams, ws] = await Promise.all([fetchWorkspaceMembers(), fetchTeams(), fetchWorkspace()]);
    return { people: members.members.length, teams: teams.teams.length, workspace: ws.workspace };
  });
  const [saved, setSaved] = useState<WorkspaceSettings | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function save(change: UpdateWorkspaceRequest, message: string) {
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      const { workspace } = await updateWorkspace(change);
      setSaved(workspace);
      setName(workspace.name);
      // The header shows the workspace name from the session, so it follows the edit.
      setSession({ ...session, workspace: { ...session.workspace, name: workspace.name } });
      setNote(message);
    } catch (err) {
      setError(isApiError(err) ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="pane-title">General</h1>
      <p className="lede">The workspace name appears in the header and in invitations.</p>
      <QueryView q={q}>
        {(summary) => {
          const ws = saved ?? summary.workspace;
          const draft = name ?? ws.name;
          const onName = (e: FormEvent) => {
            e.preventDefault();
            void save({ name: draft }, 'Workspace name saved.');
          };
          return (
            <>
              {error ? <Alert>{error}</Alert> : null}
              {note ? <Notice>{note}</Notice> : null}
              <section className="block" aria-labelledby="ws-name">
                <h2 className="bh" id="ws-name">Workspace</h2>
                <div className="block-body">
                  <form className="inline-form" onSubmit={onName} noValidate>
                    <Field label="Workspace name" value={draft} onChange={(e) => setName(e.target.value)} maxLength={80} />
                    <button type="submit" className="btn primary" disabled={busy || draft.trim() === '' || draft.trim() === ws.name}>Save name</button>
                  </form>
                  <div className="kv"><span className="k">People</span><span>{summary.people}</span></div>
                  <div className="kv"><span className="k">Teams</span><span>{summary.teams}</span></div>
                  <div className="kv"><span className="k">Your session ends</span><span><Time iso={session.expiresAt} /></span></div>
                </div>
              </section>
              <section className="block" aria-labelledby="ws-access">
                <h2 className="bh" id="ws-access">Access</h2>
                <ul className="rows">
                  <li className="srow">
                    <div>
                      <div id="ws-signup">Let people create their own account</div>
                      <div className="d">People who sign in with an allowed single sign-on domain get an account without an invitation.</div>
                    </div>
                    <Toggle label="Let people create their own account" checked={ws.selfSignup} disabled={busy} onChange={(v) => void save({ selfSignup: v }, v ? 'Self sign-up is on.' : 'Self sign-up is off.')} />
                  </li>
                  <li className="srow">
                    <div>
                      <div id="ws-password">Members can sign in with a password</div>
                      <div className="d">Admins and owners always can, so a broken provider never locks everyone out.</div>
                    </div>
                    <Toggle label="Members can sign in with a password" checked={ws.passwordForMembers} disabled={busy} onChange={(v) => void save({ passwordForMembers: v }, v ? 'Members can use the password form.' : 'The password form is hidden from members.')} />
                  </li>
                </ul>
              </section>
            </>
          );
        }}
      </QueryView>
    </>
  );
}

export function Members() {
  const q = useQuery('members', fetchWorkspaceMembers);
  return (
    <>
      <h1 className="pane-title">Members</h1>
      <QueryView q={q}>
        {({ members }) => (
          <>
            <p className="lede">{members.length} people in this workspace.</p>
            <div className="block table-wrap" data-landmark="members-table">
              <table className="table">
                <thead>
                  <tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Tags</th></tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.personId}>
                      <td data-label="Name">{m.displayName}</td>
                      <td data-label="Email" className="d-cell">{m.email}</td>
                      <td data-label="Role"><span className={`kind ${m.role === 'guest' ? 'ru' : 'h'}`}>{m.role}</span></td>
                      <td data-label="Tags">{m.tags.length ? m.tags.map((t) => <span key={t} className="tagx">{t}</span>) : <span className="faint">none</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </QueryView>
    </>
  );
}

export function Roles() {
  const q = useQuery('roles', async () => {
    const [members, teams] = await Promise.all([fetchWorkspaceMembers(), fetchTeams()]);
    const names = new Map(members.members.map((m) => [m.personId as string, m.displayName]));
    const rows: Array<{ tag: string; team: string; people: string[] }> = [];
    for (const t of teams.teams) {
      const { tags } = await fetchTeamTags(t.slug);
      for (const tag of tags) rows.push({ tag: tag.name, team: t.slug, people: tag.holders.map((id) => names.get(id) ?? 'Someone') });
    }
    return rows;
  });
  return (
    <>
      <h1 className="pane-title">Roles</h1>
      <p className="lede">Role tags come from each team's <span className="mono">TEAM.md</span>. Workspace roles are owner, admin, member and guest.</p>
      <QueryView q={q}>
        {(roles) => (
          <div className="block table-wrap" data-landmark="roles-table">
            <table className="table">
              <thead><tr><th scope="col">Tag</th><th scope="col">Team</th><th scope="col">People</th></tr></thead>
              <tbody>
                {roles.map((r) => (
                  <tr key={`${r.team}:${r.tag}`}>
                    <td data-label="Tag"><span className="tagx">{r.tag}</span></td>
                    <td data-label="Team" className="d-cell">{r.team}</td>
                    <td data-label="People">{r.people.join(', ') || <span className="faint">nobody</span>}</td>
                  </tr>
                ))}
                {roles.length === 0 ? <tr><td colSpan={3} className="faint">No role tags yet.</td></tr> : null}
              </tbody>
            </table>
          </div>
        )}
      </QueryView>
    </>
  );
}
