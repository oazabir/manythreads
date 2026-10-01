import { useState, type FormEvent } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { TeamTemplate as TemplateDefinition, type RosterMember, type TeamDetail, type TeamRole } from '@manythreads/shared';
import { isApiError } from '../api/client';
import {
  addTeamMember,
  archiveTeam,
  assignTeamTag,
  fetchRoster,
  fetchTeam,
  fetchTeamInvitations,
  fetchTeamTags,
  fetchWorkspaceMembers,
  inviteToTeam,
  removeTeamMember,
  renameTeam,
  setTeamMemberRole,
  unarchiveTeam,
  unassignTeamTag,
} from '../api/endpoints';
import { isAdmin, useSession } from '../app/session';
import { useQuery } from '../app/useQuery';
import { QueryView } from '../components/states';
import { Alert, Avatar, Field, Notice, Time } from '../components/ui';

/** /teams/:slug is the roster. */
export function TeamRedirect() {
  const { slug = '' } = useParams();
  return <Navigate to={`/settings/team/${slug}/roster`} replace />;
}

function useTeamPage() {
  const { slug = '' } = useParams();
  return { slug, q: useQuery(`team:${slug}`, () => fetchTeam(slug)) };
}

/** The stored definition is a TeamTemplate kept as JSON on the team record. */
function definitionOf(team: TeamDetail): TemplateDefinition | null {
  const parsed = TemplateDefinition.safeParse(team.templateDefinition);
  return parsed.success ? parsed.data : null;
}

const failure = (e: unknown): string => (isApiError(e) ? e.message : 'Something went wrong. Try again.');

function TemplatePanel({ team, t }: { team: TeamDetail; t: TemplateDefinition }) {
  return (
    <section className="block" aria-labelledby="tpl-def" data-landmark="template-definition">
      <h2 className="bh" id="tpl-def">
        Template definition
        <span className="cnt">{t.id} · v{t.version}</span>
        <span className="act"><Link className="btn" to={`/settings/team/${team.slug}/template`}>Open</Link></span>
      </h2>
      <div className="mrow tpl-row"><div className="k">Channels</div><div className="mono-list">{t.channels.map((c) => <span key={c.name}>{c.name}</span>)}</div></div>
      <div className="mrow tpl-row"><div className="k">Board</div><div>{t.board.name}<div className="d">{t.board.columns.join(' · ')}</div></div></div>
      {t.bots.map((b) => (
        <div className="mrow bot-row" key={b.slug}>
          <Avatar name={b.name} kind={b.automation ? 'automation' : 'agent'} />
          <div><div>{b.name}<div className="d">{b.role}</div></div></div>
          <div><span className={`kind ${b.automation ? 'ru' : 'ag'}`}>{b.automation ? 'automation' : 'agent'}</span></div>
        </div>
      ))}
      <p className="note-row">Channels and bots are created when the template is applied.</p>
    </section>
  );
}

function PersonRow({ m, slug, canManage, tagNames, act }: { m: RosterMember; slug: string; canManage: boolean; tagNames: string[]; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [tag, setTag] = useState('');
  const listId = `tags-${m.personId}`;
  return (
    <div className="mrow person-row" data-person={m.email}>
      <Avatar name={m.displayName} />
      <div><div>{m.displayName}<div className="d">{m.email}</div></div></div>
      <div><span className="kind h">person</span></div>
      <div className="roster-cell">
        {canManage ? (
          <select aria-label={`Team role for ${m.displayName}`} value={m.role} onChange={(e) => void act(() => setTeamMemberRole(slug, m.personId, e.target.value as TeamRole))}>
            <option value="lead">Team lead</option>
            <option value="member">Member</option>
          </select>
        ) : (
          <span className="mono">{m.role === 'lead' ? 'Team lead' : 'Member'}</span>
        )}
        {m.tags.map((t) => (
          <span key={t} className="tagx">
            {t}
            {canManage ? (
              <button type="button" className="tag-x" aria-label={`Remove ${t} from ${m.displayName}`} onClick={() => void act(() => unassignTeamTag(slug, m.personId, t))}>×</button>
            ) : null}
          </span>
        ))}
        {canManage ? (
          <form
            className="tag-add"
            onSubmit={(e) => {
              e.preventDefault();
              const value = tag.trim();
              if (value === '') return;
              void act(() => assignTeamTag(slug, m.personId, value.startsWith('role:') ? value : `role:${value}`)).then(() => setTag(''));
            }}
          >
            <input aria-label={`Tag for ${m.displayName}`} list={listId} value={tag} onChange={(e) => setTag(e.target.value)} placeholder="role:on-call" />
            <datalist id={listId}>{tagNames.map((t) => <option key={t} value={t} />)}</datalist>
            <button type="submit" className="btn" aria-label={`Add tag to ${m.displayName}`}>Add tag</button>
          </form>
        ) : null}
      </div>
      <div>
        {canManage ? <button type="button" className="btn" aria-label={`Remove ${m.displayName} from the team`} onClick={() => void act(() => removeTeamMember(slug, m.personId))}>Remove</button> : null}
      </div>
    </div>
  );
}

/** Team roster (proto §03 plate 1) with the template definition in place of the bots section. */
export function Roster() {
  const session = useSession();
  const { slug, q } = useTeamPage();
  const roster = useQuery(`roster:${slug}`, () => fetchRoster(slug));
  const tags = useQuery(`tags:${slug}`, () => fetchTeamTags(slug));
  const team = q.status === 'ok' ? q.data.team : undefined;
  const canManage = Boolean(team && (team.myRole === 'lead' || isAdmin(session)) && !team.archivedAt);
  const admin = isAdmin(session);
  const invitations = useQuery(`invitations:${slug}:${canManage}`, () => (canManage ? fetchTeamInvitations(slug) : Promise.resolve({ invitations: [] })));
  const workspace = useQuery(`ws-members:${admin}`, () => (admin ? fetchWorkspaceMembers() : Promise.resolve({ members: [] })));

  const [panel, setPanel] = useState<'invite' | 'add' | null>(null);
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<TeamRole>('member');
  const [addId, setAddId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);

  function refresh() {
    q.reload();
    roster.reload();
    tags.reload();
    invitations.reload();
  }

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      refresh();
    } catch (e) {
      setError(failure(e));
    }
  }

  async function invite(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLink(null);
    try {
      const res = await inviteToTeam(slug, email, inviteRole);
      setLink({ email: res.invitation.email, url: `${window.location.origin}/invite/${res.token}` });
      setEmail('');
      invitations.reload();
    } catch (err) {
      setError(failure(err));
    }
  }

  return (
    <QueryView q={q}>
      {({ team: t }) => {
        const def = definitionOf(t);
        const members = roster.status === 'ok' ? roster.data.members : [];
        const onTeam = new Set(members.map((m) => m.personId));
        const candidates = workspace.status === 'ok' ? workspace.data.members.filter((m) => m.role !== 'guest' && !onTeam.has(m.personId)) : [];
        const tagNames = tags.status === 'ok' ? tags.data.tags.map((x) => x.name) : [];
        return (
          <div className="roster" data-landmark="roster">
            <h1 className="pane-title" data-landmark="title">{t.name}{t.archivedAt ? ' (archived)' : ''}</h1>
            <p className="lede" data-landmark="lede">
              {members.length} {members.length === 1 ? 'person' : 'people'}{def ? `, ${def.bots.length} bots, ${def.channels.length} channels` : ''}. This team's memory is stored in the <span className="mono">team:{t.slug}</span> bank and is not readable from other teams.
            </p>
            {error ? <Alert>{error}</Alert> : null}

            <section className="block" aria-labelledby="people" data-landmark="people">
              <h2 className="bh" id="people">People <span className="cnt">{members.length}</span>
                {canManage ? (
                  <span className="act">
                    {admin ? <button type="button" className="btn" aria-expanded={panel === 'add'} onClick={() => setPanel(panel === 'add' ? null : 'add')}>Add person</button> : null}
                    <button type="button" className="btn" aria-expanded={panel === 'invite'} onClick={() => setPanel(panel === 'invite' ? null : 'invite')}>Invite</button>
                  </span>
                ) : null}
              </h2>
              {canManage && panel === 'invite' ? (
                <form className="invite-form" onSubmit={invite} noValidate>
                  <Field label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
                  <div className="fld">
                    <label htmlFor="invite-role">Team role</label>
                    <select id="invite-role" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as TeamRole)}>
                      <option value="member">Member</option>
                      <option value="lead">Team lead</option>
                    </select>
                  </div>
                  <button type="submit" className="btn primary">Send invitation</button>
                  {link ? <Notice>Invitation for {link.email}: <a href={link.url} className="mono">{link.url}</a> (works once)</Notice> : null}
                </form>
              ) : null}
              {canManage && panel === 'add' ? (
                <form className="invite-form" onSubmit={(e) => { e.preventDefault(); if (addId) void act(() => addTeamMember(slug, { personId: addId as never, role: 'member' })).then(() => setAddId('')); }}>
                  <div className="fld">
                    <label htmlFor="add-person">Person</label>
                    <select id="add-person" value={addId} onChange={(e) => setAddId(e.target.value)}>
                      <option value="">Choose someone…</option>
                      {candidates.map((m) => <option key={m.personId} value={m.personId}>{m.displayName} · {m.email}</option>)}
                    </select>
                  </div>
                  <button type="submit" className="btn primary" disabled={!addId}>Add to team</button>
                </form>
              ) : null}
              {roster.status === 'loading' ? <p className="loading" aria-busy="true">Loading…</p> : null}
              {members.map((m) => (
                <PersonRow key={m.personId} m={m} slug={slug} canManage={canManage} tagNames={tagNames} act={act} />
              ))}
            </section>

            {canManage && invitations.status === 'ok' && invitations.data.invitations.some((i) => !i.acceptedAt) ? (
              <section className="block" aria-labelledby="pending" data-landmark="invitations">
                <h2 className="bh" id="pending">Pending invitations</h2>
                {invitations.data.invitations.filter((i) => !i.acceptedAt).map((i) => (
                  <div className="mrow" key={i.id}>
                    <div />
                    <div>{i.email}<div className="d">expires <Time iso={i.expiresAt} /></div></div>
                    <div><span className="kind h">invited</span></div>
                  </div>
                ))}
              </section>
            ) : null}

            {def ? <TemplatePanel team={t} t={def} /> : (
              <section className="block" data-landmark="template-definition">
                <h2 className="bh">Template definition</h2>
                <p className="note-row">This team was created blank: no channels and no bots yet.</p>
              </section>
            )}

            {canManage ? <TeamActions team={t} act={act} /> : null}

            <section className="block" aria-labelledby="memory" data-landmark="memory">
              <h2 className="bh" id="memory">Memory</h2>
              <div className="mrow memory-row">
                <div>Team bank<div className="d">Built from everything that happens in this team's channels</div></div>
                <div className="mono">Hindsight · team:{t.slug}</div>
              </div>
            </section>
          </div>
        );
      }}
    </QueryView>
  );
}

function TeamActions({ team, act }: { team: TeamDetail; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [name, setName] = useState(team.name);
  return (
    <section className="block" aria-labelledby="team-actions" data-landmark="team-actions">
      <h2 className="bh" id="team-actions">Team</h2>
      <div className="block-body">
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void act(() => renameTeam(team.slug, name)); }}>
          <Field label="Team name" value={name} onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="btn" disabled={name.trim() === '' || name === team.name}>Rename</button>
          <button type="button" className="btn" onClick={() => void act(() => archiveTeam(team.slug))}>Archive team</button>
        </form>
      </div>
    </section>
  );
}

export function TeamTemplate() {
  const { slug, q } = useTeamPage();
  const session = useSession();
  return (
    <QueryView q={q}>
      {({ team }) => {
        const def = definitionOf(team);
        return (
          <>
            <h1 className="pane-title">Template</h1>
            <p className="lede">{def ? def.description : 'This team was created blank, so there is no template definition.'}</p>
            {def ? <TemplatePanel team={team} t={def} /> : null}
            {team.archivedAt && (team.myRole === 'lead' || isAdmin(session)) ? <UnarchiveButton slug={slug} /> : null}
          </>
        );
      }}
    </QueryView>
  );
}

function UnarchiveButton({ slug }: { slug: string }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      {error ? <Alert>{error}</Alert> : null}
      <button type="button" className="btn" onClick={() => unarchiveTeam(slug).then(() => window.location.reload(), (e: unknown) => setError(failure(e)))}>Restore team</button>
    </>
  );
}

export function TeamChannels() {
  const { q } = useTeamPage();
  return (
    <QueryView q={q}>
      {({ team }) => {
        const def = definitionOf(team);
        return (
          <>
            <h1 className="pane-title">Channels</h1>
            <p className="lede">Channel names stored in the template definition for {team.name}. They become real channels when the template is applied.</p>
            <section className="block" aria-label="Channels" data-landmark="channels">
              {def ? def.channels.map((c) => (
                <div className="mrow chan-row" key={c.name}><span className="mono">{c.name}</span><span className="d">{c.purpose}</span></div>
              )) : <p className="note-row">No channels yet.</p>}
            </section>
          </>
        );
      }}
    </QueryView>
  );
}
