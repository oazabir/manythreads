import type { InstallRecipeResponse, RecipeCard } from '@manythreads/shared';
import type { ReactNode } from 'react';
import { friendlyPath } from '../../components/friendlyPath';
import { Link } from 'react-router';
import { checksLine, fileRole, filedLine, needsLine, runtimeLine, stateLook, type InstallGate } from './words';

/*
 * The pieces of the recipe gallery: a card on the shelf, the facts a recipe shows before anyone installs it, and what is shown after the install filed its proposals.
 * They only draw what they are given (no requests here), so a test can render each one to markup.
 */

/** The state of a recipe as a word, a shape and a colour. */
export function StatePill({ card }: { card: Pick<RecipeCard, 'state' | 'scheduled' | 'openProposals'> }) {
  const s = stateLook(card);
  return (
    <span className={`rg-state ${s.tone}`} title={s.hint} data-testid="recipe-state" data-state={card.state}>
      <span className="rg-glyph" aria-hidden="true">{s.glyph}</span>{s.label}
    </span>
  );
}

/** One recipe on the shelf: its name, what it does in a line, what it needs, and where it stands. The whole card opens the detail. */
export function RecipeTile({ card, onOpen }: { card: RecipeCard; onOpen: (card: RecipeCard) => void }) {
  return (
    <li className="rg-item">
      <button type="button" className="rg-card" onClick={() => onOpen(card)} data-testid="recipe-card" data-recipe={card.id} aria-label={`${card.name}: ${stateLook(card).label}. Open the details.`}>
        <span className="rg-card-top">
          <span className="rg-name">{card.name}</span>
          <StatePill card={card} />
        </span>
        <span className="rg-summary">{card.summary}</span>
        <span className="rg-needs">{needsLine(card)}</span>
        <span className="rg-meta">{card.categoryLabel} · {card.schedule.label}</span>
      </button>
    </li>
  );
}

function Facts({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rg-fact">
      <h3 className="rg-fact-title">{title}</h3>
      {children}
    </section>
  );
}

function Words({ items }: { items: ReadonlyArray<string> }) {
  return (
    <ul className="rg-words">
      {items.map((x) => <li key={x}>{x}</li>)}
    </ul>
  );
}

/** Everything a person should read before adding a recipe: what it does, when, what it needs, what the bot may do, where its result goes, and which files are proposed. */
export function RecipeFacts({ card }: { card: RecipeCard }) {
  return (
    <div className="rg-facts" data-testid="recipe-facts">
      <p className="rg-lede">{card.summary}</p>
      <Facts title="When it runs">
        <p className="rg-p">{card.schedule.label} <span className="mono rg-cron">({card.schedule.cron})</span></p>
        <p className="rg-p faint">Adding the recipe does not start the schedule. After the bot is approved, a team lead turns it on in Jobs.</p>
      </Facts>
      <Facts title="What it needs">
        {card.needs.length === 0 ? <p className="rg-p">Nothing. It works in any team.</p> : <Words items={card.needs} />}
        {card.channels.length > 0 ? <p className="rg-p faint">It reads: <span className="mono">{card.channels.join(', ')}</span>. It never creates a channel.</p> : null}
      </Facts>
      <Facts title="What the bot can do">
        {card.abilities.length === 0 ? <p className="rg-p">Nothing beyond answering.</p> : <Words items={card.abilities} />}
        <p className="rg-p faint">{runtimeLine(card)}</p>
      </Facts>
      <Facts title="Where the result goes">
        <p className="rg-p">It writes <span className="mono">{card.outputPage}</span> in the team files.</p>
      </Facts>
      <Facts title="How it is checked">
        <p className="rg-p">{checksLine(card)}</p>
      </Facts>
      <Facts title="What adding it files">
        <p className="rg-p faint">Three proposals for a team lead or workspace admin to read and approve. Nothing changes before then.</p>
        <ul className="rg-files">
          {card.paths.map((p) => (
            <li key={p}><span className="rg-role">{fileRole(p)}</span> <span className="rg-path" title={p}>{friendlyPath(p)}</span></li>
          ))}
        </ul>
      </Facts>
    </div>
  );
}

/** Why the Install button is off, or nothing when it is on. Always visible text, tied to the button for screen readers. */
export function GateNote({ gate, id }: { gate: InstallGate; id: string }) {
  if (gate.reason === null) return null;
  return <p className="rg-why" id={id} data-testid="recipe-why">{gate.reason}</p>;
}

/** After the install: the proposals that were filed, each a link to its page, and the next step. */
export function Filed({ slug, result }: { slug: string; result: InstallRecipeResponse }) {
  const failed = result.proposals.filter((p) => !p.checksOk).length;
  return (
    <div className="rg-filed" role="status" data-testid="recipe-filed">
      <p className="rg-filed-title">{filedLine(result.proposals.length)}</p>
      <ul className="rg-files">
        {result.proposals.map((p) => (
          <li key={p.id}>
            <Link to={`/t/${slug}/proposals/${p.id}`} data-testid="recipe-proposal-link">{fileRole(p.path)}</Link>{' '}
            <span className="rg-path" title={p.path}>{friendlyPath(p.path)}</span>
            {p.checksOk ? null : <span className="rg-bad"> · a check failed, open it to see why</span>}
          </li>
        ))}
      </ul>
      {failed > 0 ? <p className="rg-p">A proposal with a failed check cannot be approved as it is. Open it to read the reason.</p> : null}
      <p className="rg-p faint">After the bot is approved, a team lead turns the schedule on in <Link to={`/t/${slug}/jobs`}>Jobs</Link>.</p>
    </div>
  );
}
