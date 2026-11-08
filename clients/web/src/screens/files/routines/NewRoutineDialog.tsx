import { useState, type FormEvent } from 'react';
import {
  PERSONAL_ROUTINE_RECIPES,
  PersonalRoutinePath,
  ROUTINE_SOURCES,
  personalRecipeById,
  recipeToDraft,
  type PersonalRoutine,
  type PersonalRoutineDraft,
  type RoutineOutputMode,
  type RoutineSource,
} from '@manythreads/shared';
import { Dialog } from '../../../components/Dialog';
import { message } from '../../memory/inboxWords';
import { createRoutine, draftRoutine } from './routinesApi';
import { OUTPUT_MODES, outputModeLabel, outputPlaceWords, sourceLabel, timeZoneProblem } from './routinesWords';

/**
 * New routine (PLAN P20-11): the person writes what they want in a sentence, the assistant proposes a routine, the person reads it, changes anything and confirms.
 * Nothing is switched on until the confirm button is pressed. The schedule always comes from the sentence (the proposal shows it in words); to change the time the
 * person changes the sentence and asks again. A ready routine from the shelf opens straight at the proposal.
 */

type Proposal = { draft: PersonalRoutineDraft; words: string; notes: string[]; by: 'brain' | 'rules' | 'recipe'; recipeId: string | null };

export function NewRoutineDialog({ timeZone, startWith, onClose, onCreated }: { timeZone: string; startWith: string | null; onClose: () => void; onCreated: (r: PersonalRoutine) => void }) {
  const recipe = startWith ? personalRecipeById(startWith) : undefined;
  const [sentence, setSentence] = useState(recipe?.sentence ?? '');
  const [proposal, setProposal] = useState<Proposal | null>(
    recipe ? { draft: recipeToDraft(recipe, timeZone), words: recipe.sentence, notes: [], by: 'recipe', recipeId: recipe.id } : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const propose = async (): Promise<void> => {
    const text = sentence.trim();
    if (text.length < 3 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await draftRoutine(text, timeZone);
      setProposal({ draft: r.draft, words: text, notes: r.notes, by: r.by, recipeId: null });
    } catch (e) {
      setError(message(e, 'I could not make a proposal from that. Try again, or pick one of the ready routines.'));
    } finally {
      setBusy(false);
    }
  };

  if (proposal) {
    return (
      <Review
        key={proposal.words + proposal.draft.schedule}
        proposal={proposal}
        onBack={() => {
          setSentence(proposal.words);
          setProposal(null);
          setError(null);
        }}
        onClose={onClose}
        onCreated={onCreated}
      />
    );
  }

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    void propose();
  };
  return (
    <Dialog
      title="New routine"
      onClose={onClose}
      testId="dialog-new-routine"
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || sentence.trim().length < 3} onClick={() => void propose()} data-testid="routine-propose">{busy ? 'Thinking…' : 'Show me a plan'}</button>
        </>
      }
    >
      <form className="dlg-form rt-form" onSubmit={submit}>
        <label className="dlg-label" htmlFor="rt-sentence">What should it do, and when?</label>
        <textarea
          id="rt-sentence"
          className="dlg-input rt-text"
          rows={3}
          value={sentence}
          maxLength={1000}
          onChange={(e) => setSentence(e.target.value)}
          placeholder="Every weekday at 7:30, tell me which mail needs a reply"
          data-autofocus
          data-testid="routine-sentence"
        />
        <p className="dlg-hint">Write it the way you would say it. You will see the plan and can change it before anything is turned on.</p>
        {error ? <p className="dlg-error" role="alert" data-testid="routine-propose-error">{error}</p> : null}
      </form>
      <h3 className="rt-sub">Or start from a ready one</h3>
      <ul className="rt-picks" data-testid="routine-shelf-small">
        {PERSONAL_ROUTINE_RECIPES.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              className="rt-pick"
              onClick={() => setProposal({ draft: recipeToDraft(r, timeZone), words: r.sentence, notes: [], by: 'recipe', recipeId: r.id })}
              data-testid="routine-pick"
              data-recipe={r.id}
            >
              <span className="rt-pick-name">{r.name}</span>
              <span className="rt-pick-why">{r.summary}</span>
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

function Review({ proposal, onBack, onClose, onCreated }: { proposal: Proposal; onBack: () => void; onClose: () => void; onCreated: (r: PersonalRoutine) => void }) {
  const d = proposal.draft;
  const [name, setName] = useState(d.name);
  const [prompt, setPrompt] = useState(d.prompt);
  const [sources, setSources] = useState<RoutineSource[]>(d.sources);
  const [outputPath, setOutputPath] = useState(d.outputPath);
  const [placeOpen, setPlaceOpen] = useState(false);
  const [mode, setMode] = useState<RoutineOutputMode>(d.outputMode);
  const [zone, setZone] = useState(d.timeZone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pathOk = PersonalRoutinePath.safeParse(outputPath.trim()).success && outputPath.trim().split('/')[0] !== 'Memory';
  const pathProblem = outputPath.trim() === '' || pathOk ? null : outputPath.trim().split('/')[0] === 'Memory' ? 'Memory is written by the memory tool, not by a routine.' : 'Write a file inside a folder, such as Routines/morning/output.md.';
  const zoneProblem = timeZoneProblem(zone);
  const ready = !busy && name.trim() !== '' && prompt.trim() !== '' && pathOk && zoneProblem === null;

  const toggle = (s: RoutineSource): void => setSources((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  const confirm = async (): Promise<void> => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const { routine } = await createRoutine({
        name: name.trim(),
        words: proposal.words,
        botSlug: d.botSlug || 'brain',
        schedule: d.schedule,
        scheduleWords: d.scheduleWords,
        timeZone: zone.trim(),
        prompt: prompt.trim(),
        sources: ROUTINE_SOURCES.filter((s) => sources.includes(s)),
        outputPath: outputPath.trim(),
        outputMode: mode,
        ...(proposal.recipeId ? { recipeId: proposal.recipeId } : {}),
      });
      onCreated(routine);
    } catch (e) {
      setError(message(e, 'The routine could not be saved. Nothing was turned on.'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Check the plan"
      onClose={onClose}
      testId="dialog-routine-plan"
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onBack} disabled={busy} data-testid="routine-back">Change the sentence</button>
          <button type="button" className="btn primary" disabled={!ready} onClick={() => void confirm()} data-testid="routine-confirm">{busy ? 'Saving…' : 'Turn it on'}</button>
        </>
      }
    >
      <form className="dlg-form rt-form" onSubmit={(e) => { e.preventDefault(); void confirm(); }}>
        <p className="rt-said" data-testid="routine-said">You said: {proposal.words}</p>
        {proposal.by === 'rules' ? <p className="dlg-hint" data-testid="routine-by-rules">The assistant was not available, so this plan was made by plain rules. Read the instruction and fix it where it is off.</p> : null}
        {proposal.notes.length > 0 ? (
          <ul className="rt-notes" data-testid="routine-notes">
            {proposal.notes.map((n) => <li key={n}>{n}</li>)}
          </ul>
        ) : null}

        <div className="rt-when" data-testid="routine-when">
          <span className="rt-when-label">When</span>
          <span className="rt-when-words" data-testid="routine-when-words">{d.scheduleWords}</span>
        </div>
        <p className="dlg-hint">To change the time, go back and change the sentence.</p>

        <label className="dlg-label" htmlFor="rt-name">Name</label>
        <input id="rt-name" className="dlg-input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoComplete="off" data-testid="routine-name" />

        <label className="dlg-label" htmlFor="rt-zone">Time zone</label>
        <input id="rt-zone" className="dlg-input" value={zone} maxLength={64} onChange={(e) => setZone(e.target.value)} autoComplete="off" spellCheck={false} data-testid="routine-zone" />
        {zoneProblem ? <p className="dlg-error" role="alert">{zoneProblem}</p> : null}

        <label className="dlg-label" htmlFor="rt-prompt">What the bot is asked</label>
        <textarea id="rt-prompt" className="dlg-input rt-text" rows={6} value={prompt} maxLength={8000} onChange={(e) => setPrompt(e.target.value)} data-testid="routine-prompt" />

        <fieldset className="rt-sources" data-testid="routine-sources">
          <legend className="dlg-label">What it may look at</legend>
          <div className="rt-source-grid">
            {ROUTINE_SOURCES.map((s) => (
              <label key={s} className="rt-source">
                <input type="checkbox" checked={sources.includes(s)} onChange={() => toggle(s)} data-testid="routine-source" data-source={s} />
                <span>{sourceLabel(s)}</span>
              </label>
            ))}
          </div>
          <p className="dlg-hint">A routine only ever reads what you could read yourself, in your own conversation with the bot.</p>
        </fieldset>

        <span className="dlg-label" id="rt-path-label">Where the answer goes</span>
        {placeOpen ? (
          <>
            <input id="rt-path" className="dlg-input" aria-labelledby="rt-path-label" value={outputPath} maxLength={300} onChange={(e) => setOutputPath(e.target.value)} autoComplete="off" spellCheck={false} data-testid="routine-output-path" />
            <p className="dlg-hint">Write the name of a file inside one of your folders. It is kept in your own files.</p>
          </>
        ) : (
          <p className="dlg-hint rt-place" data-testid="routine-output-words">
            {outputPlaceWords(outputPath)} <button type="button" className="link-btn" onClick={() => setPlaceOpen(true)} data-testid="routine-output-change">Choose another place</button>
          </p>
        )}
        {pathProblem ? <p className="dlg-error" role="alert">{pathProblem}</p> : null}
        <label className="dlg-label" htmlFor="rt-mode">Each time it runs</label>
        <select id="rt-mode" className="dlg-input" value={mode} onChange={(e) => setMode(e.target.value as RoutineOutputMode)} data-testid="routine-output-mode">
          {OUTPUT_MODES.map((m) => <option key={m} value={m}>{outputModeLabel(m)}</option>)}
        </select>

        <p className="dlg-hint">It will not be switched on until you press Turn it on, and you can pause or delete it any time.</p>
        {error ? <p className="dlg-error" role="alert" data-testid="routine-create-error">{error}</p> : null}
      </form>
    </Dialog>
  );
}
