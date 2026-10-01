import { useState, type FormEvent } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { isApiError } from '../api/client';
import { fetchTeam, inviteToTeam } from '../api/endpoints';
import type { TeamDetail, TemplateInfo } from '../api/schemas';
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

const presenceDot = { online: 'up', away: 'busy', offline: 'off' } as const;

function TemplatePanel({ team, t }: { team: TeamDetail; t: TemplateInfo }) {
  return (
    <section className="block" aria-labelledby="tpl-def" data-landmark="template-definition">
      <h2 className="bh" id="tpl-def">
        Template definition
        <span className="cnt">{team.templateId} · v{team.templateVersion}{team.appliedAt ? <> · applied <Time iso={team.appliedAt} /></> : null}</span>
        <span className="act"><Link className="btn" to={`/settings/team/${team.slug}/template`}>Open</Link></span>
      </h2>
      <div className="mrow tpl-row"><div className="k">Channels</div><div className="mono-list">{t.channels.map((c) => <span key={c}>{c}</span>)}</div></div>
      {t.board ? <div className="mrow tpl-row"><div className="k">Board</div><div>{t.board}</div></div> : null}
      {t.bots.map((b) => (
        <div className="mrow bot-row" key={b.name}>
          <Avatar name={b.name} kind={b.automation ? 'automation' : 'agent'} />
          <div><div>{b.name}<div className="d">{b.role}</div></div></div>
          <div><span className={`kind ${b.automation ? 'ru' : 'ag'}`}>{b.automation ? 'automation' : 'agent'}</span></div>
        </div>
      ))}
      <p className="note-row">Stored as text. Channels are created when the template is applied in phase 3, bots in phase 5.</p>
    </section>
  );
}

/** Team roster (proto §03 plate 1) with the template definition in place of the bots section. */
export function Roster() {
  const { slug, q } = useTeamPage();
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  async function invite(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSent(null);
    try {
      await inviteToTeam(slug, email);
      setSent(email);
      setEmail('');
    } catch (err) {
      setError(isApiError(err) ? err.message : 'Something went wrong. Try again.');
    }
  }

  return (
    <QueryView q={q}>
      {(team) => {
        const bots = team.template?.bots.length ?? 0;
        const channels = team.template?.channels.length ?? 0;
        return (
          <>
            <h1 className="pane-title">{team.name}</h1>
            <p className="lede">
              {team.members.length} {team.members.length === 1 ? 'person' : 'people'}, {bots} bots, {channels} channels. This team's memory is stored in the <span className="mono">team:{team.slug}</span> bank and is not readable from other teams.
            </p>

            <section className="block" aria-labelledby="people" data-landmark="people">
              <h2 className="bh" id="people">People <span className="cnt">{team.members.length}</span>
                <span className="act"><button type="button" className="btn" aria-expanded={inviting} onClick={() => setInviting(!inviting)}>Invite</button></span>
              </h2>
              {inviting ? (
                <form className="invite-form" onSubmit={invite} noValidate>
                  <Field label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
                  <button type="submit" className="btn primary">Send invitation</button>
                  {error ? <Alert>{error}</Alert> : null}
                  {sent ? <Notice>Invitation sent to {sent}.</Notice> : null}
                </form>
              ) : null}
              {team.members.map((m) => (
                <div className="mrow" key={m.id}>
                  <Avatar name={m.name} />
                  <div><div>{m.name}<div className="d">{m.email}</div></div></div>
                  <div><span className="kind h">person</span></div>
                  <div className="mono">{m.role === 'lead' ? 'Team lead' : 'Member'}{m.tags.map((t) => <span key={t} className="tagx">{t}</span>)}</div>
                  <div><span className={`dot ${presenceDot[m.presence]}`} /><span className="mono">{m.presence}</span></div>
                </div>
              ))}
            </section>

            {team.template ? <TemplatePanel team={team} t={team.template} /> : (
              <section className="block" data-landmark="template-definition">
                <h2 className="bh">Template definition</h2>
                <p className="note-row">This team was created blank: one channel, no bots.</p>
              </section>
            )}

            <section className="block" aria-labelledby="memory" data-landmark="memory">
              <h2 className="bh" id="memory">Memory</h2>
              <div className="mrow memory-row">
                <div>Team bank<div className="d">Built from everything that happens in this team's channels</div></div>
                <div className="mono">Hindsight · team:{team.slug}</div>
              </div>
            </section>
          </>
        );
      }}
    </QueryView>
  );
}

export function TeamTemplate() {
  const { q } = useTeamPage();
  return (
    <QueryView q={q}>
      {(team) => (
        <>
          <h1 className="pane-title">Template</h1>
          <p className="lede">{team.template ? team.template.description : 'This team was created blank, so there is no template definition.'}</p>
          {team.template ? <TemplatePanel team={team} t={team.template} /> : null}
        </>
      )}
    </QueryView>
  );
}

export function TeamChannels() {
  const { q } = useTeamPage();
  return (
    <QueryView q={q}>
      {(team) => (
        <>
          <h1 className="pane-title">Channels</h1>
          <p className="lede">Channel names stored in the template definition for {team.name}. They become real channels when the template is applied in phase 3.</p>
          <section className="block" aria-label="Channels" data-landmark="channels">
            {team.template ? team.template.channels.map((c) => (
              <div className="mrow chan-row" key={c}><span className="mono">{c}</span></div>
            )) : <p className="note-row">No channels yet.</p>}
          </section>
        </>
      )}
    </QueryView>
  );
}
