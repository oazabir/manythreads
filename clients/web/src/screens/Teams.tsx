import { useState } from 'react';
import { Link } from 'react-router';
import type { TemplateSummary } from '@manythreads/shared';
import { isApiError } from '../api/client';
import { applyTeamTemplate, createBlankTeam, fetchTemplates, inviteToTeam } from '../api/endpoints';
import { isAdmin, useSession } from '../app/session';
import { useQuery } from '../app/useQuery';
import { useTeams } from '../components/frames';
import { EmptyState, QueryView } from '../components/states';
import { Alert, Notice } from '../components/ui';

const BLANK = '__blank__';
type Pick = { name: string; slug: string; slugTouched: boolean; invite: string };
type Created = { slug: string; name: string; created: boolean; invitations: Array<{ email: string; link?: string; error?: string }> };

export const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);

const failure = (e: unknown): string => (isApiError(e) ? e.message : 'Something went wrong. Try again.');

/** Teams list and the create-from-template picker (proto §01 plate 4 · Step 5 · Teams). */
export function Teams() {
  const session = useSession();
  const admin = isAdmin(session);
  const { teams, loading, reload } = useTeams();
  const templates = useQuery('templates', fetchTemplates);
  const [picked, setPicked] = useState<Record<string, Pick>>({});
  const [results, setResults] = useState<Created[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const count = Object.keys(picked).length;

  const toggle = (id: string, name: string) =>
    setPicked((cur) => {
      const next = { ...cur };
      if (next[id]) delete next[id];
      else next[id] = { name, slug: slugify(name), slugTouched: false, invite: '' };
      return next;
    });
  const patch = (id: string, p: Partial<Pick>) =>
    setPicked((cur) => {
      const old = cur[id];
      if (!old) return cur;
      const merged = { ...old, ...p };
      if (p.name !== undefined && !merged.slugTouched) merged.slug = slugify(p.name);
      return { ...cur, [id]: merged };
    });

  async function create() {
    setError(null);
    setBusy(true);
    try {
      for (const [id, p] of Object.entries(picked)) {
        const name = p.name.trim();
        const slug = p.slug.trim() === '' ? undefined : p.slug.trim();
        const made =
          id === BLANK
            ? { team: (await createBlankTeam({ name, ...(slug ? { slug } : {}) })).team, created: true }
            : await applyTeamTemplate({ templateId: id, name, ...(slug ? { slug } : {}) });
        const invitations: Created['invitations'] = [];
        for (const email of p.invite.split(/[\s,;]+/).filter(Boolean)) {
          try {
            const inv = await inviteToTeam(made.team.slug, email);
            invitations.push({ email, link: `${window.location.origin}/invite/${inv.token}` });
          } catch (e) {
            invitations.push({ email, error: failure(e) });
          }
        }
        setResults((cur) => [...cur, { slug: made.team.slug, name: made.team.name, created: made.created, invitations }]);
        setPicked((cur) => {
          const next = { ...cur };
          delete next[id];
          return next;
        });
      }
    } catch (e) {
      setError(failure(e));
    } finally {
      reload();
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="pane-title">{admin ? 'Which teams do you want?' : 'Teams'}</h1>
      <p className="lede">
        {admin ? 'Pick templates, rename them, invite people. You can add a blank team too.' : 'The teams you belong to.'}
      </p>

      {!loading && teams.length === 0 ? (
        <EmptyState title={admin ? 'Create your first team.' : 'You are not on a team yet.'}>
          {admin ? 'A team gets channels, a board, a memory bank and default bots from its template.' : 'A workspace admin can add you to one.'}
        </EmptyState>
      ) : null}

      {results.map((r) => (
        <section key={r.slug} className="block" aria-label={`${r.name} created`} data-landmark="created">
          <h2 className="bh">{r.created ? 'Created' : 'Already exists'}: <Link to={`/settings/team/${r.slug}/roster`}>{r.name}</Link></h2>
          <div className="block-body">
            {r.invitations.length === 0 ? <p className="note-row">No invitations sent.</p> : null}
            {r.invitations.map((i) =>
              i.link ? (
                <Notice key={i.email}>Invitation for {i.email}: <a href={i.link} className="mono">{i.link}</a> (works once; also mailed when mail is set up)</Notice>
              ) : (
                <Alert key={i.email}>{i.email}: {i.error}</Alert>
              ),
            )}
          </div>
        </section>
      ))}

      {teams.length > 0 ? (
        <section className="block" aria-labelledby="your-teams" data-landmark="teams-list">
          <h2 className="bh" id="your-teams">Teams <span className="cnt">{teams.length}</span></h2>
          <ul className="rows">
            {teams.map((t) => (
              <li key={t.slug} className="srow">
                <div>
                  <Link to={`/settings/team/${t.slug}/roster`}>{t.name}</Link>
                  <div className="d">{t.memberCount} {t.memberCount === 1 ? 'person' : 'people'}{t.template ? ` · template ${t.template}` : ''}{t.archivedAt ? ' · archived' : ''}</div>
                </div>
                {t.myRole ? <span className="kind h">{t.myRole === 'lead' ? 'Team lead' : 'Member'}</span> : <span className="kind ru">admin</span>}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {admin ? (
        <QueryView q={templates}>
          {({ templates: list }) => (
            <section aria-label="Team templates" data-landmark="template-picker">
              <div className="grid2 tpls">
                {list.map((t) => (
                  <TemplateCard key={t.id} t={t} pick={picked[t.id]} onToggle={() => toggle(t.id, t.name)} onPatch={(p) => patch(t.id, p)} />
                ))}
                <BlankCard pick={picked[BLANK]} onToggle={() => toggle(BLANK, 'New team')} onPatch={(p) => patch(BLANK, p)} />
              </div>
              {error ? <Alert>{error}</Alert> : null}
              <div className="actions">
                <button type="button" className="btn primary" disabled={count === 0 || busy || Object.values(picked).some((p) => p.name.trim() === '')} onClick={() => void create()}>
                  {count === 1 ? 'Create 1 team' : `Create ${count} teams`}
                </button>
                <span className="skip">{count === 0 ? 'Tick at least one team' : 'Channels and bots are created when the template is applied'}</span>
              </div>
            </section>
          )}
        </QueryView>
      ) : null}
    </>
  );
}

function CardShell({ on, label, onToggle, children }: { on: boolean; label: string; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div className={`tpl ${on ? 'on' : ''}`}>
      <button type="button" className="cb" role="checkbox" aria-checked={on} aria-label={label} onClick={onToggle} />
      <div>{children}</div>
    </div>
  );
}

function PickFields({ id, label, pick, onPatch, withInvite }: { id: string; label: string; pick: Pick; onPatch: (p: Partial<Pick>) => void; withInvite: boolean }) {
  return (
    <>
      <input className="nm" aria-label={`${label} team name`} value={pick.name} onChange={(e) => onPatch({ name: e.target.value })} />
      <div className="fld inv">
        <label htmlFor={`slug-${id}`}>Slug</label>
        <input id={`slug-${id}`} value={pick.slug} onChange={(e) => onPatch({ slug: e.target.value, slugTouched: true })} aria-label={`${label} team slug`} />
      </div>
      {withInvite ? (
        <div className="fld inv">
          <label htmlFor={`inv-${id}`}>Invite</label>
          <input id={`inv-${id}`} aria-label={`${label} invite emails`} value={pick.invite} onChange={(e) => onPatch({ invite: e.target.value })} placeholder="nadia@kahf.co, tariq@kahf.co" />
        </div>
      ) : null}
    </>
  );
}

function TemplateCard({ t, pick, onToggle, onPatch }: { t: TemplateSummary; pick?: Pick; onToggle: () => void; onPatch: (p: Partial<Pick>) => void }) {
  return (
    <CardShell on={Boolean(pick)} label={`Create a ${t.name} team`} onToggle={onToggle}>
      <b>{t.name}</b>
      <div className="d">{t.description}</div>
      <div className="ch">
        {t.channels.map((c) => <span key={c}>{c}</span>)}
      </div>
      <div className="bots">{t.bots.map((b) => b.name).join(' · ')}</div>
      {pick ? <PickFields id={t.id} label={t.name} pick={pick} onPatch={onPatch} withInvite /> : null}
    </CardShell>
  );
}

function BlankCard({ pick, onToggle, onPatch }: { pick?: Pick; onToggle: () => void; onPatch: (p: Partial<Pick>) => void }) {
  return (
    <CardShell on={Boolean(pick)} label="Create a blank team" onToggle={onToggle}>
      <b>Blank team</b>
      <div className="bots">No channels and no bots yet. Build it up yourself.</div>
      {pick ? <PickFields id={BLANK} label="Blank" pick={pick} onPatch={onPatch} withInvite /> : null}
    </CardShell>
  );
}
