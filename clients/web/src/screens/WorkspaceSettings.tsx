import { fetchTeamTags, fetchTeams, fetchWorkspaceMembers } from '../api/endpoints';
import { useSession } from '../app/session';
import { useQuery } from '../app/useQuery';
import { QueryView } from '../components/states';
import { Time } from '../components/ui';

export function WorkspaceGeneral() {
  const session = useSession();
  const q = useQuery('workspace-summary', async () => {
    const [members, teams] = await Promise.all([fetchWorkspaceMembers(), fetchTeams()]);
    return { people: members.members.length, teams: teams.teams.length };
  });
  return (
    <>
      <h1 className="pane-title">General</h1>
      <p className="lede">The workspace name appears in the header and in invitations.</p>
      <QueryView q={q}>
        {(summary) => (
          <div className="block">
            <div className="block-body">
              <div className="kv"><span className="k">Workspace</span><span>{session.workspace.name}</span></div>
              <div className="kv"><span className="k">People</span><span>{summary.people}</span></div>
              <div className="kv"><span className="k">Teams</span><span>{summary.teams}</span></div>
              <div className="kv"><span className="k">Your session ends</span><span><Time iso={session.expiresAt} /></span></div>
            </div>
          </div>
        )}
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
