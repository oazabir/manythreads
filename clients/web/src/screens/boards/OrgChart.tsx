import { SkeletonRows } from '../../components/Skeleton';
import { Avatar } from '../../components/ui';
import { orgChart, mayTagLabel, mayTagResolves, type OrgPerson } from './board';
import { HandToIcon } from './icons';
import { useTeamPeople } from './people';

/*
 * The org chart (SPEC §6.5, PLAN P6-07, P21-15): the team as the cards see it, drawn as a grid. The leads come first, then everyone else, each
 * with a picture; the bots follow as small purple cards, and under each bot an arrow to every bot, person or role it may hand work to. The
 * arrows are not decoration: `handover.mayTag` is the compiled allowlist a bot's handoff is checked against, so an arrow here is a move the
 * server will accept, and a target that has left the team is shown as missing rather than dropped (the definition still names it, and the
 * next handoff will be refused). Every band is a grid of equal columns, so cards in a row line up whatever their content.
 */

function PersonCard({ p }: { p: OrgPerson }) {
  return (
    <li className={`bd-person${p.lead ? ' lead' : ''}`} data-testid="org-person" data-actor={p.actorId}>
      <Avatar name={p.name} avatar={p.avatar} personId={p.personId} />
      <span className="bd-person-text">
        <span className="bd-person-name">{p.name}</span>
        <span className="bd-person-role">{p.lead ? 'lead' : 'member'}</span>
        {p.tags.length > 0 ? (
          <span className="bd-tags">
            {p.tags.map((t) => (
              <span key={t} className="bd-tag">{t}</span>
            ))}
          </span>
        ) : null}
      </span>
    </li>
  );
}

export function OrgChart({ slug }: { slug: string }) {
  const people = useTeamPeople(slug);
  if (people.loading) return <SkeletonRows rows={5} avatar label="Loading the team" />;
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
        <ul className="bd-org-grid">
          {chart.leads.map((p) => <PersonCard key={p.actorId} p={p} />)}
        </ul>
      </section>

      <section className="bd-org-band" data-testid="org-members" aria-label="Members">
        <h3>Members</h3>
        {chart.members.length === 0 ? <p className="bd-muted">Nobody else is on the team.</p> : null}
        <ul className="bd-org-grid">
          {chart.members.map((p) => <PersonCard key={p.actorId} p={p} />)}
        </ul>
      </section>

      <section className="bd-org-band" data-testid="org-bots" aria-label="Bots">
        <h3>Bots</h3>
        {chart.bots.length === 0 ? <p className="bd-muted">No bots on this team yet.</p> : null}
        <ul className="bd-org-grid bots">
          {chart.bots.map((b) => (
            <li key={b.slug} className="bd-org-bot" data-testid="org-bot" data-bot={b.slug}>
              <div className="bd-org-bot-who">
                <Avatar name={b.name} kind="agent" avatar={b.avatar} />
                <span className="bd-person-text">
                  <span className="bd-person-name">{b.name}</span>
                  <span className="bd-person-role">{b.slug}</span>
                  {b.role ? <span className="bd-org-bot-role">{b.role}</span> : null}
                </span>
              </div>
              <div className="bd-edges">
                {b.mayTag.length === 0 ? (
                  <span className="bd-muted">Cannot hand work to other bots yet.</span>
                ) : (
                  <>
                    <span className="bd-edges-label">may hand to</span>
                    {b.mayTag.map((tag) => {
                      const resolves = mayTagResolves(tag, everyone, chart.bots);
                      return (
                        <span key={tag} className={`bd-edge ${resolves ? '' : 'missing'}`} data-tag={tag}>
                          <HandToIcon />
                          {mayTagLabel(tag, everyone, chart.bots)}
                          {resolves ? '' : ' (not on the team)'}
                        </span>
                      );
                    })}
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
