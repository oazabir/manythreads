import { useState, type FormEvent } from 'react';
import { isApiError } from '../api/client';
import { fetchMembers, fetchRoles, fetchWorkspace, renameWorkspace } from '../api/endpoints';
import { useSessionState } from '../app/session';
import { useQuery } from '../app/useQuery';
import { QueryView } from '../components/states';
import { Alert, Field, Notice } from '../components/ui';

export function WorkspaceGeneral() {
  const q = useQuery('workspace', fetchWorkspace);
  const { refresh } = useSessionState();
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  return (
    <>
      <h1 className="pane-title">General</h1>
      <p className="lede">The workspace name appears in the header and in invitations.</p>
      <QueryView q={q}>
        {(ws) => {
          const value = name ?? ws.name;
          const onSubmit = async (e: FormEvent) => {
            e.preventDefault();
            setError(null);
            setSaved(false);
            try {
              await renameWorkspace(value);
              setSaved(true);
              refresh();
              q.reload();
            } catch (err) {
              setError(isApiError(err) ? err.message : 'Something went wrong. Try again.');
            }
          };
          return (
            <div className="block">
              <form className="block-body" onSubmit={onSubmit} noValidate>
                <Field label="Workspace name" value={value} onChange={(e) => { setName(e.target.value); setSaved(false); }} />
                <div className="kv"><span className="k">People</span><span>{ws.memberCount}</span></div>
                <div className="kv"><span className="k">Teams</span><span>{ws.teamCount}</span></div>
                {error ? <Alert>{error}</Alert> : null}
                {saved ? <Notice>Saved.</Notice> : null}
                <div className="form-actions"><button type="submit" className="btn primary" disabled={value === ws.name || value.trim() === ''}>Save</button></div>
              </form>
            </div>
          );
        }}
      </QueryView>
    </>
  );
}

export function Members() {
  const q = useQuery('members', fetchMembers);
  return (
    <>
      <h1 className="pane-title">Members</h1>
      <QueryView q={q}>
        {(members) => (
          <>
            <p className="lede">{members.length} people in this workspace.</p>
            <div className="block table-wrap" data-landmark="members-table">
              <table className="table">
                <thead>
                  <tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Tags</th></tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.id}>
                      <td data-label="Name">{m.name}</td>
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
  const q = useQuery('roles', fetchRoles);
  return (
    <>
      <h1 className="pane-title">Roles</h1>
      <p className="lede">Role tags come from each team's <span className="mono">TEAM.md</span>. Workspace roles are owner, admin, member and guest.</p>
      <QueryView q={q}>
        {(roles) => (
          <div className="block table-wrap" data-landmark="roles-table">
            <table className="table">
              <thead><tr><th scope="col">Tag</th><th scope="col">Used for</th><th scope="col">Team</th><th scope="col">People</th></tr></thead>
              <tbody>
                {roles.map((r) => (
                  <tr key={r.tag}>
                    <td data-label="Tag"><span className="tagx">{r.tag}</span></td>
                    <td data-label="Used for">{r.description}</td>
                    <td data-label="Team" className="d-cell">{r.teamSlug}</td>
                    <td data-label="People">{r.members.join(', ') || <span className="faint">nobody</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </QueryView>
    </>
  );
}
