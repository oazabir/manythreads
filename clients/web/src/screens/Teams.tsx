import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { isApiError } from '../api/client';
import { createTeam, fetchTemplates } from '../api/endpoints';
import type { TemplateInfo } from '../api/schemas';
import { isAdmin, useSession } from '../app/session';
import { useQuery } from '../app/useQuery';
import { useTeams } from '../components/frames';
import { EmptyState, QueryView } from '../components/states';
import { Alert } from '../components/ui';

const BLANK = '__blank__';
type Pick = { name: string; invite: string };

/** Teams list and the create-from-template picker (proto §01 plate 4 · Step 5 · Teams). */
export function Teams() {
  const session = useSession();
  const admin = isAdmin(session);
  const { teams, loading, reload } = useTeams();
  const templates = useQuery('templates', fetchTemplates);
  const navigate = useNavigate();
  const [picked, setPicked] = useState<Record<string, Pick>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const existing = useMemo(() => new Set(teams.map((t) => t.templateId).filter(Boolean)), [teams]);
  const count = Object.keys(picked).length;

  const toggle = (id: string, name: string) =>
    setPicked((cur) => {
      const next = { ...cur };
      if (next[id]) delete next[id];
      else next[id] = { name, invite: '' };
      return next;
    });
  const patch = (id: string, p: Partial<Pick>) => setPicked((cur) => (cur[id] ? { ...cur, [id]: { ...cur[id], ...p } } : cur));

  async function create() {
    setError(null);
    setBusy(true);
    const created: string[] = [];
    try {
      for (const [id, p] of Object.entries(picked)) {
        const team = await createTeam({
          templateId: id === BLANK ? null : id,
          name: p.name.trim(),
          invite: p.invite.split(/[\s,;]+/).filter(Boolean),
        });
        created.push(team.slug);
        setPicked((cur) => {
          const next = { ...cur };
          delete next[id];
          return next;
        });
      }
      reload();
      if (created.length === 1) navigate(`/settings/team/${created[0]}/roster`);
    } catch (e) {
      setError(isApiError(e) ? e.message : 'Something went wrong. Try again.');
      reload();
    } finally {
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

      {teams.length > 0 ? (
        <section className="block" aria-labelledby="your-teams" data-landmark="teams-list">
          <h2 className="bh" id="your-teams">Teams <span className="cnt">{teams.length}</span></h2>
          <ul className="rows">
            {teams.map((t) => (
              <li key={t.slug} className="srow">
                <div>
                  <Link to={`/settings/team/${t.slug}/roster`}>{t.name}</Link>
                  <div className="d">{t.memberCount} {t.memberCount === 1 ? 'person' : 'people'}{t.templateId ? ` · template ${t.templateId}` : ''}</div>
                </div>
                {t.myRole ? <span className="kind h">{t.myRole === 'lead' ? 'Team lead' : 'Member'}</span> : <span className="kind ru">admin</span>}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {admin ? (
        <QueryView q={templates}>
          {(list: TemplateInfo[]) => (
            <section aria-label="Team templates" data-landmark="template-picker">
              <div className="grid2 tpls">
                {list.map((t) => (
                  <TemplateCard key={t.id} t={t} disabled={existing.has(t.id)} pick={picked[t.id]} onToggle={() => toggle(t.id, t.name)} onPatch={(p) => patch(t.id, p)} />
                ))}
                <BlankCard pick={picked[BLANK]} onToggle={() => toggle(BLANK, 'New team')} onPatch={(p) => patch(BLANK, p)} />
              </div>
              {error ? <Alert>{error}</Alert> : null}
              <div className="actions">
                <button type="button" className="btn primary" disabled={count === 0 || busy || Object.values(picked).some((p) => p.name.trim() === '')} onClick={create}>
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

function CardShell({ on, disabled, label, onToggle, children }: { on: boolean; disabled?: boolean; label: string; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div className={`tpl ${on ? 'on' : ''} ${disabled ? 'off' : ''}`}>
      <button type="button" className="cb" role="checkbox" aria-checked={on} aria-label={label} disabled={disabled} onClick={onToggle} />
      <div>{children}</div>
    </div>
  );
}

function TemplateCard({ t, pick, disabled, onToggle, onPatch }: { t: TemplateInfo; pick?: Pick; disabled: boolean; onToggle: () => void; onPatch: (p: Partial<Pick>) => void }) {
  return (
    <CardShell on={Boolean(pick)} disabled={disabled} label={`Create a ${t.name} team`} onToggle={onToggle}>
      {pick ? (
        <input className="nm" aria-label={`${t.name} team name`} value={pick.name} onChange={(e) => onPatch({ name: e.target.value })} />
      ) : null}
      <b>{t.name}{disabled ? <span className="chip ok created">created</span> : null}</b>
      <div className="ch">
        {t.channels.map((c) => <span key={c}>{c}</span>)}
      </div>
      <div className="bots">{t.bots.map((b) => b.name).join(' · ')}</div>
      {t.needs.length ? <div className="needs">{t.needs.map((n) => <span key={n} className="chip no">needs: {n}</span>)}</div> : null}
      {pick ? (
        <div className="fld inv">
          <label htmlFor={`inv-${t.id}`}>Invite</label>
          <input id={`inv-${t.id}`} value={pick.invite} onChange={(e) => onPatch({ invite: e.target.value })} placeholder="nadia@kahf.co, tariq@kahf.co" />
        </div>
      ) : null}
    </CardShell>
  );
}

function BlankCard({ pick, onToggle, onPatch }: { pick?: Pick; onToggle: () => void; onPatch: (p: Partial<Pick>) => void }) {
  return (
    <CardShell on={Boolean(pick)} label="Create a blank team" onToggle={onToggle}>
      {pick ? <input className="nm" aria-label="Blank team name" value={pick.name} onChange={(e) => onPatch({ name: e.target.value })} /> : null}
      <b>Blank team</b>
      <div className="bots">One channel, no bots. Build it up yourself.</div>
    </CardShell>
  );
}
