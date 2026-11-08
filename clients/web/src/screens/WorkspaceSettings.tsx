import { useId, useState, type FormEvent } from 'react';
import { isApiError } from '../api/client';
import { fetchTeamTags, fetchTeams, fetchWorkspace, fetchWorkspaceMembers, requestPasswordReset, updateWorkspace, updateWorkspaceMember } from '../api/endpoints';
import { useSession, useSessionState } from '../app/session';
import { useQuery } from '../app/useQuery';
import { QueryView } from '../components/states';
import { Dialog } from '../components/Dialog';
import { Alert, Avatar, Field, Notice, Time, Toggle } from '../components/ui';
import { sayToast } from '../kernel/toast';
import { AddIcon, SearchIcon } from '../shell/icons';
import type { ListWorkspaceMembersResponse, UpdateWorkspaceRequest, WorkspaceRole, WorkspaceSettings } from '@manythreads/shared';
import { InviteDialog } from './InviteDialog';
import { MoreMenu, type MoreItem } from './bots/MoreMenu';
import { filterMembers, lastActiveText } from './members';
import { PageHeader } from '../components/PageHeader';
import { DeactivateDialog, OpenSpaceDialog, reactivate } from './PersonalSpaceAdmin';
import { OffboardDialog } from './admin/connections/OffboardDialog';

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
      <PageHeader title="General" />
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

type Member = ListWorkspaceMembersResponse['members'][number];
const ROLE_CHOICES: ReadonlyArray<{ role: WorkspaceRole; label: string; hint: string }> = [
  { role: 'owner', label: 'Owner', hint: 'Everything an admin can do, and can make or remove other owners.' },
  { role: 'admin', label: 'Admin', hint: 'Changes workspace settings and manages people.' },
  { role: 'member', label: 'Member', hint: 'Works in the teams they belong to.' },
  { role: 'guest', label: 'Guest', hint: 'Sees only the channels they were given.' },
];

export function Members() {
  const session = useSession();
  const q = useQuery('members', fetchWorkspaceMembers);
  const [search, setSearch] = useState('');
  const [inviting, setInviting] = useState(false);
  const [changing, setChanging] = useState<Member | null>(null);
  const [opening, setOpening] = useState<Member | null>(null);
  const [deactivating, setDeactivating] = useState<Member | null>(null);
  const [removingConnections, setRemovingConnections] = useState<Member | null>(null);
  const searchId = useId();

  const sendReset = (m: Member): void => {
    requestPasswordReset(m.email).then(
      () => sayToast(`A password reset link is on its way to ${m.email}.`, { testId: 'member-note' }),
      (e: unknown) => sayToast(isApiError(e) ? e.message : 'Could not send the reset link. Try again.', { testId: 'member-note' }),
    );
  };
  const menuFor = (m: Member): ReadonlyArray<MoreItem> => {
    const items: MoreItem[] = [];
    // you do not change your own role here (it could lock you out), and only an owner touches an owner
    if (m.personId !== session.person.id && (m.role !== 'owner' || session.role === 'owner')) {
      items.push({ label: 'Change role', testId: 'member-change-role', onSelect: () => setChanging(m) });
    }
    items.push({ label: 'Send a password reset', testId: 'member-reset', onSelect: () => sendReset(m) });
    // a guest has no Personal space; nobody opens their own here (they have it open already)
    if (m.personId !== session.person.id && m.role !== 'guest') {
      items.push({ label: 'Open Personal space', testId: 'member-open-space', onSelect: () => setOpening(m) });
    }
    // you do not deactivate yourself, and only an owner touches an owner
    if (m.personId !== session.person.id && (m.role !== 'owner' || session.role === 'owner')) {
      items.push(
        m.status === 'suspended'
          ? { label: 'Reactivate', testId: 'member-reactivate', onSelect: () => void reactivate(m.personId, m.displayName, q.reload) }
          : { label: 'Deactivate', testId: 'member-deactivate', onSelect: () => setDeactivating(m) },
      );
    }
    // admins only (the server says 403 to anyone else); not for yourself, and only an owner touches an owner
    if ((session.role === 'owner' || session.role === 'admin') && m.personId !== session.person.id && (m.role !== 'owner' || session.role === 'owner')) {
      items.push({ label: 'Remove their connections', testId: 'member-remove-connections', onSelect: () => setRemovingConnections(m) });
    }
    return items;
  };

  return (
    <>
      <PageHeader
        title="Members"
        description={q.status === 'ok' ? `${q.data.members.length} ${q.data.members.length === 1 ? 'person' : 'people'} in this workspace.` : undefined}
        actions={<button type="button" className="btn primary" data-testid="invite-people" onClick={() => setInviting(true)}><AddIcon size={14} /> Invite people</button>}
      />
      <QueryView q={q}>
        {({ members }) => {
          const shown = filterMembers(members, search);
          return (
            <>
              <div className="mem-search">
                <label htmlFor={searchId} className="sr-only">Search people</label>
                <span className="mem-search-ico" aria-hidden="true"><SearchIcon size={14} /></span>
                <input id={searchId} className="mem-input" type="search" placeholder="Search by name or email" value={search} onChange={(e) => setSearch(e.target.value)} autoComplete="off" data-testid="members-search" />
              </div>
              <div className="block mem-wrap" data-landmark="members-table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Name</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Tags</th><th scope="col">Last active</th>
                      <th scope="col"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((m) => (
                      <tr key={m.personId} data-testid="member-row">
                        <td data-label="Name" className="mem-c"><span className="mem-name"><Avatar name={m.displayName} personId={m.personId} /><span>{m.displayName}</span>{m.status === 'suspended' ? <span className="kind ru" data-testid="member-deactivated">Deactivated</span> : null}</span></td>
                        <td data-label="Email" className="mem-c d-cell">{m.email}</td>
                        <td data-label="Role" className="mem-c"><span className={`kind ${m.role === 'guest' ? 'ru' : 'h'}`}>{m.role}</span></td>
                        <td data-label="Tags" className="mem-c">{m.tags.length ? m.tags.map((t) => <span key={t} className="tagx">{t}</span>) : <span className="faint">none</span>}</td>
                        <td data-label="Last active" className="mem-c d-cell" title={m.lastActiveAt ?? undefined}><span data-vt-mask>{lastActiveText(m.lastActiveAt)}</span></td>
                        <td className="mem-c mem-act"><MoreMenu compact label={`Options for ${m.displayName}`} testId="member-menu" items={menuFor(m)} /></td>
                      </tr>
                    ))}
                    {shown.length === 0 ? <tr><td colSpan={6} className="faint" data-testid="members-none">No one matches "{search.trim()}".</td></tr> : null}
                  </tbody>
                </table>
              </div>
            </>
          );
        }}
      </QueryView>
      {inviting ? <InviteDialog onClose={() => setInviting(false)} /> : null}
      {changing ? <ChangeRoleDialog member={changing} onClose={() => setChanging(null)} onChanged={q.reload} /> : null}
      {opening ? <OpenSpaceDialog personId={opening.personId} name={opening.displayName} onClose={() => setOpening(null)} /> : null}
      {removingConnections ? <OffboardDialog personId={removingConnections.personId} name={removingConnections.displayName} onClose={() => setRemovingConnections(null)} /> : null}
      {deactivating ? <DeactivateDialog personId={deactivating.personId} name={deactivating.displayName} guest={deactivating.role === 'guest'} onClose={() => setDeactivating(null)} onDone={q.reload} /> : null}
    </>
  );
}

function ChangeRoleDialog({ member, onClose, onChanged }: { member: Member; onClose: () => void; onChanged: () => void }) {
  const session = useSession();
  const roleId = useId();
  const [role, setRole] = useState<WorkspaceRole>(member.role);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choices = ROLE_CHOICES.filter((c) => c.role !== 'owner' || session.role === 'owner');

  async function save(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      await updateWorkspaceMember(member.personId, { role });
      sayToast(`${member.displayName} is now ${role === 'admin' || role === 'owner' ? 'an' : 'a'} ${role}.`, { testId: 'member-note' });
      onChanged();
      onClose();
    } catch (e) {
      setError(isApiError(e) ? e.message : 'Could not change the role. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Change role for ${member.displayName}`}
      onClose={onClose}
      testId="change-role-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || role === member.role} data-testid="change-role-save" onClick={() => void save()}>Save role</button>
        </>
      }
    >
      <div className="fld">
        <label htmlFor={roleId}>Role</label>
        <select id={roleId} value={role} onChange={(e) => setRole(e.target.value as WorkspaceRole)} data-testid="change-role-select">
          {choices.map((c) => <option key={c.role} value={c.role}>{c.label}</option>)}
        </select>
        <div className="fld-hint">{ROLE_CHOICES.find((c) => c.role === role)?.hint}</div>
      </div>
      {error ? <Alert>{error}</Alert> : null}
    </Dialog>
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
      <PageHeader title="Roles" />
      <p className="lede">Role tags are set in each team's own settings. Workspace roles are owner, admin, member and guest.</p>
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
