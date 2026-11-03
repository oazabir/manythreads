import { useId, useMemo, useState } from 'react';
import type { TeamSummary } from '@manythreads/shared';
import { Dialog } from '../../components/Dialog';
import { message } from './inboxWords';
import { createShare } from './shareApi';
import { SCHEDULES, TRUST_CHOICES, definitionYaml, draftProblem, draftToDefinition, emptyDraft, shareFile, slugOfName, type ShareDraft } from './shareWords';

type Props = {
  slug: string;
  /** The other teams this one may send to. */
  teams: readonly Pick<TeamSummary, 'slug' | 'name'>[];
  /** The file names of the shares the team already has, so a new one never replaces one. */
  taken: ReadonlySet<string>;
  onClose: () => void;
  onDone: (said: string) => void;
};

/**
 * New share: a name, the teams to send to, what to pick from memory, how often and who approves. It writes the share's file (`routines/shares/<name>.yaml`) in the
 * team's repository, which a lead or admin applies at once. Each team named is then asked to accept; nothing is sent to a team until it does.
 */
export function ShareDialog({ slug, teams, taken, onClose, onDone }: Props) {
  const uid = useId();
  const [draft, setDraft] = useState<ShareDraft>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const problem = useMemo(() => draftProblem(draft, taken), [draft, taken]);
  const file = slugOfName(draft.name);
  const set = <K extends keyof ShareDraft>(key: K, value: ShareDraft[K]): void => setDraft((d) => ({ ...d, [key]: value }));
  const toggleTeam = (team: string, on: boolean): void => setDraft((d) => ({ ...d, to: on ? [...d.to, team] : d.to.filter((t) => t !== team) }));
  const text = useMemo(() => (problem === null ? definitionYaml(draftToDefinition(draft)) : null), [problem, draft]);

  const submit = async (): Promise<void> => {
    setTouched(true);
    if (problem !== null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createShare(slug, draft);
      onDone(`“${draft.name.trim()}” was created. ${draft.to.length === 1 ? 'The team' : 'Each team'} you named is asked to accept it, and nothing is sent until it does.`);
      onClose();
    } catch (e) {
      setBusy(false);
      setError(message(e, 'The share could not be created. Try again.'));
    }
  };

  return (
    <Dialog
      title="New share"
      onClose={onClose}
      testId="share-dialog"
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy} aria-disabled={problem !== null || undefined} onClick={() => void submit()} data-testid="share-submit">{busy ? 'Creating…' : 'Create share'}</button>
        </>
      }
    >
      <p className="mi-help">A share is a standing offer to pass some of this team’s memory to other teams. Nothing leaves until a lead of each receiving team says yes and a lead here approves each digest. Notes about people, originals such as emails and documents, and anything marked team only never go.</p>

      <label className="mi-label" htmlFor={`${uid}-name`}>Name</label>
      <input id={`${uid}-name`} className="mi-input" type="text" maxLength={120} value={draft.name} onChange={(e) => set('name', e.target.value)} autoComplete="off" data-testid="share-name-input" data-autofocus />
      {file !== '' ? <p className="ms-hint">Saved as <code className="mono">{shareFile(file)}</code></p> : null}

      <fieldset className="ms-fields" data-testid="share-teams">
        <legend className="mi-label">Send to</legend>
        {teams.length === 0 ? <p className="faint">There is no other team to send to yet.</p> : null}
        {teams.map((t) => (
          <label key={t.slug} className="check ms-check">
            <input type="checkbox" checked={draft.to.includes(t.slug)} onChange={(e) => toggleTeam(t.slug, e.target.checked)} data-testid={`share-team-${t.slug}`} />
            <span>{t.name}</span>
          </label>
        ))}
      </fieldset>

      <fieldset className="ms-fields">
        <legend className="mi-label">What to share</legend>
        <p className="ms-hint">Leave a box empty to not filter on it. A concept is one page of the team’s memory.</p>
        <label className="mi-label" htmlFor={`${uid}-paths`}>Folders</label>
        <input id={`${uid}-paths`} className="mi-input" type="text" value={draft.paths} placeholder="decisions/, playbooks/" onChange={(e) => set('paths', e.target.value)} autoComplete="off" data-testid="share-paths" />
        <label className="mi-label" htmlFor={`${uid}-types`}>Kinds of concept</label>
        <input id={`${uid}-types`} className="mi-input" type="text" value={draft.types} placeholder="Decision, Playbook" onChange={(e) => set('types', e.target.value)} autoComplete="off" data-testid="share-types" />
        <label className="mi-label" htmlFor={`${uid}-tags`}>Tags</label>
        <input id={`${uid}-tags`} className="mi-input" type="text" value={draft.tags} placeholder="release, customer-impact" onChange={(e) => set('tags', e.target.value)} autoComplete="off" data-testid="share-tags" />
        <label className="mi-label" htmlFor={`${uid}-trust`}>How well checked</label>
        <select id={`${uid}-trust`} className="mi-input" value={draft.minTrust} onChange={(e) => set('minTrust', e.target.value as ShareDraft['minTrust'])} data-testid="share-trust">
          {TRUST_CHOICES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        <label className="check ms-check">
          <input type="checkbox" checked={draft.skipStale} onChange={(e) => set('skipStale', e.target.checked)} data-testid="share-skip-stale" />
          <span>Leave out concepts that are out of date</span>
        </label>
      </fieldset>

      <fieldset className="ms-fields">
        <legend className="mi-label">What a digest holds</legend>
        <label className="check ms-check">
          <input type="radio" name={`${uid}-mode`} checked={draft.mode === 'summary'} onChange={() => set('mode', 'summary')} data-testid="share-mode-summary" />
          <span>A short summary only</span>
        </label>
        <label className="check ms-check">
          <input type="radio" name={`${uid}-mode`} checked={draft.mode === 'full'} onChange={() => set('mode', 'full')} data-testid="share-mode-full" />
          <span>A summary and a copy of each concept</span>
        </label>
      </fieldset>

      <label className="mi-label" htmlFor={`${uid}-when`}>How often</label>
      <select id={`${uid}-when`} className="mi-input" value={draft.schedule} onChange={(e) => set('schedule', e.target.value as ShareDraft['schedule'])} data-testid="share-when">
        {SCHEDULES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select>
      {draft.schedule === 'custom' ? (
        <>
          <label className="mi-label" htmlFor={`${uid}-cron`}>Schedule (minute hour day-of-month month day-of-week, UTC)</label>
          <input id={`${uid}-cron`} className="mi-input mono" type="text" value={draft.cron} placeholder="0 8 * * 1" onChange={(e) => set('cron', e.target.value)} autoComplete="off" data-testid="share-cron" />
        </>
      ) : null}

      <fieldset className="ms-fields">
        <legend className="mi-label">Before a digest goes</legend>
        <label className="check ms-check">
          <input type="radio" name={`${uid}-approval`} checked={draft.approval === 'review'} onChange={() => set('approval', 'review')} data-testid="share-approval-review" />
          <span>A lead approves each digest in Approvals</span>
        </label>
        <label className="check ms-check">
          <input type="radio" name={`${uid}-approval`} checked={draft.approval === 'auto'} onChange={() => set('approval', 'auto')} data-testid="share-approval-auto" />
          <span>Send without a review (only works while you are a lead or admin)</span>
        </label>
      </fieldset>

      {text ? (
        <details className="ms-more">
          <summary data-testid="share-file-toggle">The file this writes</summary>
          <pre className="ms-yaml mono" data-testid="share-file">{text}</pre>
        </details>
      ) : null}
      {touched && problem ? <p className="mi-error" role="alert" data-testid="share-problem">{problem}</p> : null}
      {error ? <p className="mi-error" role="alert" data-testid="share-dialog-error">{error}</p> : null}
    </Dialog>
  );
}
