import { useId, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { createChannel } from '../api/endpoints';
import { Dialog } from '../components/Dialog';
import { refreshDirectory } from './channelFeed';
import { NAME_RULE, TOPIC_MAX, buildRequest, createErrorText, nameProblem, normalizeChannelName } from './newChannel';
import { channelPath } from './nav';

/**
 * "New channel": a name, an optional topic and who can see it. Shown only to a lead of the team or a workspace admin (the people the server
 * lets create one). A successful creation opens the new channel.
 */
export function NewChannelDialog({ slug, onClose }: { slug: string; onClose: () => void }) {
  const navigate = useNavigate();
  const formId = useId();
  const hintId = useId();
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false); // set at once, before the next render, so a quick second press cannot send twice
  const [error, setError] = useState<string | null>(null);
  const typedProblem = nameProblem(name);
  const clean = normalizeChannelName(name);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (sending.current) return;
    const built = buildRequest({ name, topic, isPrivate });
    if (!built.ok) {
      setError(built.problem);
      return;
    }
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      const { channel } = await createChannel(slug, built.request);
      void refreshDirectory(slug);
      onClose();
      navigate(channelPath(slug, channel.name));
    } catch (err) {
      setError(createErrorText(err, built.request.name));
      sending.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="New channel"
      onClose={onClose}
      testId="new-channel-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form={formId} className="btn primary" disabled={busy || clean === '' || typedProblem !== null} data-testid="new-channel-create">
            {busy ? 'Creating…' : 'Create channel'}
          </button>
        </>
      }
    >
      <form id={formId} className="nc-form" onSubmit={(e) => void submit(e)} noValidate>
        <div className="dlg-form">
          <label className="dlg-label" htmlFor={`${formId}-name`}>Name</label>
          <div className="nc-name">
            <span className="nc-hash" aria-hidden="true">#</span>
            <input
              id={`${formId}-name`}
              className="dlg-input"
              data-testid="new-channel-name"
              data-autofocus
              value={name}
              maxLength={64}
              autoComplete="off"
              spellCheck={false}
              placeholder="release-notes"
              aria-describedby={hintId}
              aria-invalid={typedProblem !== null || undefined}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
            />
          </div>
          <p id={hintId} className={typedProblem ? 'dlg-hint nc-bad' : 'dlg-hint'} data-testid="new-channel-hint">
            {typedProblem ?? (clean !== '' && clean !== name ? `It will be called #${clean}.` : NAME_RULE)}
          </p>
        </div>
        <div className="dlg-form">
          <label className="dlg-label" htmlFor={`${formId}-topic`}>Topic (optional)</label>
          <input
            id={`${formId}-topic`}
            className="dlg-input"
            data-testid="new-channel-topic"
            value={topic}
            maxLength={TOPIC_MAX}
            autoComplete="off"
            placeholder="What this channel is for"
            onChange={(e) => setTopic(e.target.value)}
          />
        </div>
        <fieldset className="nc-who">
          <legend className="dlg-label">Who can see it</legend>
          <label className="nc-opt">
            <input type="radio" name={`${formId}-who`} checked={!isPrivate} onChange={() => setIsPrivate(false)} data-testid="new-channel-public" />
            <span>
              <strong>Everyone on the team</strong>
              <span className="dlg-hint">Anyone on the team can find it and join.</span>
            </span>
          </label>
          <label className="nc-opt">
            <input type="radio" name={`${formId}-who`} checked={isPrivate} onChange={() => setIsPrivate(true)} data-testid="new-channel-private" />
            <span>
              <strong>Only people you add</strong>
              <span className="dlg-hint">Private. You are the first member; add the others afterwards.</span>
            </span>
          </label>
        </fieldset>
        {error ? <p className="dlg-error" role="alert" data-testid="new-channel-error">{error}</p> : null}
      </form>
    </Dialog>
  );
}
