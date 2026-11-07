import { Link, useParams, useSearchParams } from 'react-router';
import { PageHeader } from '../../components/PageHeader';
import { ForbiddenBody } from '../../components/states';
import { useQuery } from '../../app/useQuery';
import { useShell } from '../../shell/context';
import { KnowledgeBasePanel } from '../bots/knowledge';
import { SpaceSwitch } from '../memory/SpaceSwitch';
import { fetchTeamBases } from './api';
import { PersonalKnowledge } from './PersonalKnowledge';
import { countLine } from './words';

/**
 * The Knowledge screen has two sides, chosen by the switch at the top. Personal (`/knowledge`) is your own knowledge bases: files only you can search, and Brain
 * when you ask it and have said it may. Teams (`/t/<team>/knowledge`) lists the team's bases and opens each with the panel the bot page uses. A guest has no
 * Personal side (P20-06).
 */
export function KnowledgeScreen() {
  const { team } = useParams<{ team: string }>();
  const { guest, teams } = useShell();
  const personal = team === undefined;
  if (personal && guest) return <ForbiddenBody />;

  const firstTeam = teams[0]?.slug ?? null;
  const space = guest ? null : (
    <SpaceSwitch
      space={personal ? 'personal' : 'teams'}
      label="Whose knowledge"
      personalHref="/knowledge"
      teamsHref={personal ? (firstTeam ? `/t/${encodeURIComponent(firstTeam)}/knowledge` : null) : `/t/${encodeURIComponent(team)}/knowledge`}
    />
  );

  return (
    <section className="kn-screen" data-space={personal ? 'personal' : 'teams'} data-testid="knowledge-screen">
      <PageHeader
        title="Knowledge"
        description={personal ? 'Files and notes only you can search. Brain reads them when you ask it in a private conversation.' : 'The documents a team’s bots can search.'}
        actions={space}
      />
      {personal ? <PersonalKnowledge /> : <TeamKnowledge slug={team} />}
    </section>
  );
}

/** The Teams side: the team's bases, and the one picked, shown with the panel of the bot page's Knowledge tab. */
function TeamKnowledge({ slug }: { slug: string }) {
  const q = useQuery(`team-knowledge:${slug}`, () => fetchTeamBases(slug));
  const [params, setParams] = useSearchParams();
  if (q.status === 'loading') return <div className="view-empty" aria-busy="true" />;
  if (q.status === 'error') return <p className="mi-error" role="alert" data-testid="team-knowledge-error">The team’s knowledge could not be loaded: {q.error.message}</p>;
  const { bases, canWrite } = q.data;
  const wanted = params.get('base');
  const selected = bases.find((b) => b.slug === wanted) ?? bases[0] ?? null;
  if (bases.length === 0) {
    return (
      <p className="mi-empty faint" data-testid="team-knowledge-empty">
        This team has no knowledge bases yet. {canWrite ? 'Add one from a bot’s Knowledge section.' : 'A team lead can add one from a bot’s Knowledge section.'} <Link to={`/t/${encodeURIComponent(slug)}/bots`}>Open the team’s bots</Link>
      </p>
    );
  }
  return (
    <div className="kn-body" data-testid="team-knowledge">
      <ul className="kn-bases" aria-label="The team’s knowledge bases" data-testid="team-knowledge-list">
        {bases.map((b) => (
          <li key={b.slug} className="kn-base-item">
            <button type="button" className={`kn-base-row ${selected?.slug === b.slug ? 'on' : ''}`} aria-current={selected?.slug === b.slug ? 'true' : undefined} onClick={() => setParams({ base: b.slug })} data-testid="team-knowledge-row" data-base={b.slug}>
              <span className="kn-base-name">{b.name}</span>
              <span className="kn-base-meta">{countLine(b.documentCount, 'document', 'documents')}</span>
            </button>
          </li>
        ))}
      </ul>
      {selected ? (
        <div className="kn-detail">
          <h2 className="kn-title">{selected.name}</h2>
          <KnowledgeBasePanel key={selected.slug} team={slug} base={selected.slug} canEdit={canWrite} />
        </div>
      ) : null}
    </div>
  );
}

export default KnowledgeScreen;
