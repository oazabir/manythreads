import { orgChart, mayTagLabel, mayTagResolves } from './board';
import { useTeamPeople } from './people';

/*
 * The org chart (SPEC §6.5, PLAN P6-07): the team as the cards see it — the leads, then everyone else, and beside them the bots with
 * the hands each one may tag. The edges are not decoration: `handover.mayTag` is the compiled allowlist a bot's handoff is checked
 * against, so an arrow here is a move the server will accept, and a target that has left the team is shown as missing rather than
 * dropped (the definition still names it, and the next handoff will be refused).
 */

export function OrgChart({ slug }: { slug: string }) {
  const people = useTeamPeople(slug);
  if (people.loading) return <p className="loading" aria-busy="true">Loading…</p>;
  if (people.error) return <p className="bd-muted" role="alert">The roster could not be loaded: {people.error.message}</p>;
  const chart = orgChart(people.roster, people.bots);
  const everyone = [...chart.leads, ...chart.members];

  return (
    <div className="bd-org" data-testid="org-chart">
      <p className="bd-hint" data-testid="org-count">
        {chart.leads.length} lead{chart.leads.length === 1 ? '' : 's'} · {chart.members.length} member{chart.members.length === 1 ? '' : 's'} ·{' '}
        {chart.bots.length} bot{chart.bots.length === 1 ? '' : 's'}
      </p>

      <section className="bd-org-band" data-testid="org-leads" aria-label="Leads">
        <h3>Leads</h3>
        {chart.leads.length === 0 ? <p className="bd-muted">No lead yet: the workspace admin decides who can manage this team.</p> : null}
        <div className="bd-org-people">
          {chart.leads.map((p) => (
            <div key={p.actorId} className="bd-person lead" data-testid="org-person" data-actor={p.actorId}>
              <span className="bd-person-name">{p.name}</span>
              <span className="bd-person-role">lead</span>
              {p.tags.length > 0 ? (
                <span className="bd-tags">
                  {p.tags.map((t) => (
                    <span key={t} className="bd-tag">{t}</span>
                  ))}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      <section className="bd-org-band" data-testid="org-members" aria-label="Members">
        <h3>Members</h3>
        {chart.members.length === 0 ? <p className="bd-muted">Nobody else is on the team.</p> : null}
        <div className="bd-org-people">
          {chart.members.map((p) => (
            <div key={p.actorId} className="bd-person" data-testid="org-person" data-actor={p.actorId}>
              <span className="bd-person-name">{p.name}</span>
              <span className="bd-person-role">member</span>
              {p.tags.length > 0 ? (
                <span className="bd-tags">
                  {p.tags.map((t) => (
                    <span key={t} className="bd-tag">{t}</span>
                  ))}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      <section className="bd-org-band" data-testid="org-bots" aria-label="Bots">
        <h3>Bots</h3>
        {chart.bots.length === 0 ? <p className="bd-muted">No bots loaded yet: a bot appears when its BOT.md is committed.</p> : null}
        <div className="bd-org-bots">
          {chart.bots.map((b) => (
            <div key={b.slug} className="bd-org-bot" data-testid="org-bot" data-bot={b.slug}>
              <div className="bd-org-bot-who">
                <span className="bd-person-name">{b.name}</span>
                <span className="bd-person-role">{b.slug}</span>
                {b.role ? <span className="bd-org-bot-role">{b.role}</span> : null}
              </div>
              <div className="bd-edges">
                {b.mayTag.length === 0 ? (
                  <span className="bd-muted">May hand a card to nobody: `handover.mayTag` is empty.</span>
                ) : (
                  <>
                    <span className="bd-edges-label">may hand to</span>
                    {b.mayTag.map((tag) => (
                      <span key={tag} className={`bd-tag ${mayTagResolves(tag, everyone, chart.bots) ? '' : 'missing'}`} data-tag={tag}>
                        {mayTagLabel(tag, everyone, chart.bots)}
                        {mayTagResolves(tag, everyone, chart.bots) ? '' : ' (not on the team)'}
                      </span>
                    ))}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
