import { useState, type FormEvent } from 'react';
import { POLL_ANONYMOUS_MIN_READERS, POLL_MAX_OPTIONS, POLL_OPTION_MAX, POLL_QUESTION_MAX } from '@manythreads/shared';
import { isApiError } from '../api/client';
import { Dialog } from '../components/Dialog';
import { channelStore } from './store';
import { EMPTY_FORM, UNIT_LABEL, canAddOption, canRemoveOption, pollFailureText, requestOf, type CloseUnit, type PollForm } from './polls';
import { CloseIcon } from '../shell/icons';

/** The "Poll" composer action (and `/poll` with nothing after it): a small dialog for the question, two to ten options and the rules. */
export function PollDialog({
  channelId,
  threadRootId,
  initial,
  onClose,
  onDone,
}: {
  channelId: string;
  threadRootId: string | null;
  /** A question and options already typed after `/poll`, when the command was incomplete. */
  initial?: Partial<PollForm>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [form, setForm] = useState<PollForm>({ ...EMPTY_FORM, ...initial });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<PollForm>): void => {
    setError(null);
    setForm((f) => ({ ...f, ...patch }));
  };
  const setOption = (i: number, text: string): void => set({ options: form.options.map((o, at) => (at === i ? text : o)) });

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    const built = requestOf(form, new Date(), threadRootId);
    if (!built.ok) {
      setError(built.reason);
      return;
    }
    setBusy(true);
    try {
      await channelStore.createPoll(channelId, built.request);
      onDone();
    } catch (err) {
      setError(isApiError(err) ? pollFailureText(err.status, err.message) : pollFailureText(undefined, undefined));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Ask a poll"
      onClose={onClose}
      testId="poll-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="poll-form" className="btn primary" disabled={busy} data-testid="poll-create">{busy ? 'Posting…' : 'Post poll'}</button>
        </>
      }
    >
      <form id="poll-form" className="poll-form" onSubmit={(e) => void submit(e)} noValidate>
        <label className="poll-f">
          <span>Question</span>
          <input type="text" className="dlg-input" value={form.question} maxLength={POLL_QUESTION_MAX} onChange={(e) => set({ question: e.target.value })} data-autofocus data-testid="poll-question" />
        </label>
        <fieldset className="poll-f poll-f-opts">
          <legend>Options</legend>
          {form.options.map((o, i) => (
            <div key={i} className="poll-f-row">
              <input
                type="text"
                className="dlg-input"
                value={o}
                maxLength={POLL_OPTION_MAX}
                aria-label={`Option ${i + 1}`}
                placeholder={`Option ${i + 1}`}
                onChange={(e) => setOption(i, e.target.value)}
                data-testid="poll-option-input"
              />
              <button type="button" className="icon-btn" aria-label={`Remove option ${i + 1}`} title="Remove" disabled={!canRemoveOption(form.options)} onClick={() => set({ options: form.options.filter((_, at) => at !== i) })}>
                <CloseIcon size={12} />
              </button>
            </div>
          ))}
          <button type="button" className="link-btn" disabled={!canAddOption(form.options)} onClick={() => set({ options: [...form.options, ''] })} data-testid="poll-add-option">
            {canAddOption(form.options) ? 'Add an option' : `At most ${POLL_MAX_OPTIONS} options`}
          </button>
        </fieldset>
        <label className="poll-check">
          <input type="checkbox" checked={form.multiple} onChange={(e) => set({ multiple: e.target.checked })} data-testid="poll-multiple" />
          <span>People can choose more than one option</span>
        </label>
        <label className="poll-check">
          <input type="checkbox" checked={form.anonymous} onChange={(e) => set({ anonymous: e.target.checked })} data-testid="poll-anonymous" />
          <span>
            Anonymous votes: nobody can read who voted for what, not even you or an admin. The totals still move live, so in a small group they can give a vote away:
            anonymous polls need a channel of at least {POLL_ANONYMOUS_MIN_READERS} people.
          </span>
        </label>
        <div className="poll-f poll-f-close">
          <label htmlFor="poll-close-unit">Closes</label>
          <div className="poll-f-row">
            {form.closeUnit === 'never' ? null : (
              <>
                <span aria-hidden="true">in</span>
                <input
                  type="number"
                  min={1}
                  inputMode="numeric"
                  className="dlg-input poll-amount"
                  aria-label="Close after how many"
                  value={form.closeAmount}
                  onChange={(e) => set({ closeAmount: e.target.value })}
                  data-testid="poll-close-amount"
                />
              </>
            )}
            <select id="poll-close-unit" className="dlg-input" value={form.closeUnit} onChange={(e) => set({ closeUnit: e.target.value as CloseUnit })} data-testid="poll-close-unit">
              {(Object.keys(UNIT_LABEL) as CloseUnit[]).map((u) => (
                <option key={u} value={u}>{UNIT_LABEL[u]}</option>
              ))}
            </select>
          </div>
        </div>
        {error ? <p className="dlg-error" role="alert" data-testid="poll-form-error">{error}</p> : null}
      </form>
    </Dialog>
  );
}
