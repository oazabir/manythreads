import type { InstallRecipeResponse, RecipeCard } from '@manythreads/shared';
import { useId, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useSession } from '../../app/session';
import { useQuery } from '../../app/useQuery';
import { Dialog } from '../../components/Dialog';
import { QueryView } from '../../components/states';
import { Alert } from '../../components/ui';
import { useHeaderTopic } from '../../shell/topic';
import { useProposalPerms } from '../proposals/store';
import { fetchRecipes, installRecipe } from './api';
import { Filed, GateNote, RecipeFacts, RecipeTile, StatePill } from './parts';
import { RECIPES_TOPIC, installGate, onShelf, shelfFrom, shelves } from './words';

/*
 * The recipe gallery (PLAN P18-01, docs/plugins/workshop.md "The recipe gallery"): ready-made automations a team can ask for. A card says what a recipe does, what it needs and where it
 * stands in this team; a press opens the details (the address keeps `?recipe=` so the page can be shared and Back closes it). Install files three proposals as the signed-in person; a team
 * lead or workspace admin applies them on the Proposals page. The gallery adds nothing to the team itself.
 */

const errorText = (err: unknown): string => (err instanceof Error && err.message ? err.message : 'That did not work. Try again.');

function RecipeDialog({ card, slug, canInstall, canApply, guest, onClose, onFiled }: {
  card: RecipeCard;
  slug: string;
  canInstall: boolean;
  canApply: boolean;
  guest: boolean;
  onClose: () => void;
  onFiled: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InstallRecipeResponse | null>(null);
  const whyId = useId();
  // after the install the server's fresh card (now "waiting") replaces the one the gallery was opened with
  const shown = result?.recipe ?? card;
  const gate = installGate({ guest, canApply }, shown, canInstall);

  const install = (): void => {
    if (busy || !gate.allowed) return;
    setBusy(true);
    setError(null);
    installRecipe(slug, card.id).then(
      (r) => {
        setResult(r);
        setBusy(false);
        onFiled();
      },
      (err: unknown) => {
        setError(errorText(err));
        setBusy(false);
      },
    );
  };

  const footer = (
    <>
      {shown.state === 'waiting' && result === null ? <Link className="btn" to={`/t/${slug}/proposals`} data-testid="recipe-open-proposals">See the proposals</Link> : null}
      {result !== null ? <Link className="btn" to={`/t/${slug}/proposals`} data-testid="recipe-open-proposals">Open Proposals</Link> : null}
      {shown.state === 'installed' ? <Link className="btn" to={`/t/${slug}/bots/${shown.bot.slug}`} data-testid="recipe-open-bot">Open {shown.bot.name}</Link> : null}
      <button type="button" className="btn" onClick={onClose} data-testid="recipe-close">Close</button>
      {result === null && shown.state === 'available' ? (
        <button
          type="button"
          className="btn primary"
          disabled={!gate.allowed || busy}
          aria-describedby={gate.reason ? whyId : undefined}
          onClick={install}
          data-testid="recipe-install"
        >
          {busy ? 'Filing…' : 'Install'}
        </button>
      ) : null}
    </>
  );

  return (
    <Dialog title={shown.name} onClose={onClose} wide sheet startAtTop testId="recipe-dialog" footer={footer}>
      <p className="rg-dlg-state"><StatePill card={shown} /> <span className="faint">{shown.categoryLabel}</span></p>
      {result !== null ? <Filed slug={slug} result={result} /> : null}
      {result === null ? <GateNote gate={gate} id={whyId} /> : null}
      {error !== null ? <Alert>{error}</Alert> : null}
      <RecipeFacts card={shown} />
    </Dialog>
  );
}

export function RecipesScreen() {
  const { slug, canApply } = useProposalPerms();
  const guest = useSession().role === 'guest';
  useHeaderTopic(RECIPES_TOPIC);
  const [params, setParams] = useSearchParams();
  const q = useQuery(`recipes:${slug}`, () => fetchRecipes(slug));
  const shelf = shelfFrom(params.get('shelf'));
  const open = params.get('recipe');

  const setParam = (name: string, value: string | null, replace = false): void => {
    const next = new URLSearchParams(params);
    if (value === null) next.delete(name);
    else next.set(name, value);
    setParams(next, { replace });
  };

  return (
    <div className="rg-screen" data-testid="recipes-screen">
      <div className="rg-head">
        <div>
          <h2 className="rg-title">Recipes</h2>
          <p className="rg-sub">Ready-made automations. Pick one, read what it does, and ask for it. A team lead or workspace admin approves it before anything is added.</p>
        </div>
        <div className="rg-head-act">
          <Link className="btn s" to={`/t/${slug}/bots/new`} data-testid="recipes-describe">Describe your own</Link>
          <Link className="btn s" to={`/t/${slug}/bots`} data-testid="recipes-bots">Back to Bots</Link>
        </div>
      </div>
      <QueryView q={q}>
        {({ recipes, canInstall }) => {
          const chips = shelves(recipes);
          const shown = onShelf(recipes, shelf);
          const current = open === null ? undefined : recipes.find((r) => r.id === open);
          return (
            <>
              {recipes.length === 0 ? (
                <div className="rg-empty" data-testid="recipes-empty">
                  <p className="rg-empty-title">No recipes yet</p>
                  <p className="rg-empty-body">This workspace has no ready-made automations. You can still describe what you want and a helper drafts the bot.</p>
                  <Link className="btn primary" to={`/t/${slug}/bots/new`}>Add a bot</Link>
                </div>
              ) : (
                <>
                  <div className="rg-chips" role="group" aria-label="Shelves">
                    {chips.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className={`rg-chip ${shelf === c.id ? 'on' : ''}`}
                        aria-pressed={shelf === c.id}
                        data-testid={`recipes-shelf-${c.id}`}
                        onClick={() => setParam('shelf', c.id === 'all' ? null : c.id, true)}
                      >
                        {c.label} <span className="rg-count">{c.count}</span>
                      </button>
                    ))}
                  </div>
                  <p className="rg-found faint" role="status" aria-live="polite" data-testid="recipes-count">
                    {shown.length === 1 ? '1 recipe' : `${String(shown.length)} recipes`}
                  </p>
                  <ul className="rg-grid" aria-label="Recipes">
                    {shown.map((r) => <RecipeTile key={r.id} card={r} onOpen={(c) => setParam('recipe', c.id)} />)}
                  </ul>
                </>
              )}
              {open !== null && current === undefined ? (
                <p className="rg-gone" role="status" data-testid="recipe-missing">
                  There is no recipe called “{open.slice(0, 40)}”. <button type="button" className="linkish" onClick={() => setParam('recipe', null, true)}>Clear</button>
                </p>
              ) : null}
              {current ? (
                <RecipeDialog
                  card={current}
                  slug={slug}
                  canInstall={canInstall}
                  canApply={canApply}
                  guest={guest}
                  onClose={() => setParam('recipe', null)}
                  onFiled={q.reload}
                />
              ) : null}
            </>
          );
        }}
      </QueryView>
    </div>
  );
}
