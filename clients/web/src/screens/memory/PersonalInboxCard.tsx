import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { PersonalInboxItem } from '@manythreads/shared';
import { Time } from '../../components/ui';
import { conceptName, itemLook, kindLabel, message, originLabel, sizeLabel } from './inboxWords';
import { discardPersonalItem, releasePersonalItem, retryPersonalItem } from './personalApi';
import { filedFiles, filedReference, personalActions, personalConceptLink, personalSentence, titleFor } from './personalWords';

type Props = {
  item: PersonalInboxItem;
  /** File titles by path, when the files could be read (a path with no title shows its file name). */
  titles: ReadonlyMap<string, string>;
  /** After an action: the item as the server now has it. */
  onChanged: (item: PersonalInboxItem, said: string) => void;
  /** Open the Send to team dialog for this item. */
  onSendToTeam: (item: PersonalInboxItem) => void;
};

/**
 * One drop in your own inbox: its name, where it stands, what it became (links to the files it wrote) and, because it is yours, Retry, Let it through and Discard.
 * A discard deletes the original, so it asks first.
 */
export function PersonalInboxCard({ item, titles, onChanged, onSendToTeam }: Props) {
  const look = itemLook(item);
  const can = personalActions(item);
  const [busy, setBusy] = useState<null | 'retry' | 'release' | 'discard'>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const discardBtn = useRef<HTMLButtonElement>(null);
  const keepBtn = useRef<HTMLButtonElement>(null);
  const asked = useRef(false);
  const files = filedFiles(item);
  const reference = filedReference(item);
  const sentence = personalSentence(item);

  // the button that was pressed is replaced by the question: focus goes to the safe answer, and back to Discard when the question is dropped
  useEffect(() => {
    if (confirm) keepBtn.current?.focus();
    else if (asked.current) discardBtn.current?.focus();
    asked.current = confirm;
  }, [confirm]);

  const run = async (kind: 'retry' | 'release' | 'discard'): Promise<void> => {
    setBusy(kind);
    setError(null);
    try {
      const act = kind === 'retry' ? retryPersonalItem : kind === 'release' ? releasePersonalItem : discardPersonalItem;
      const { item: next } = await act(item.id);
      setConfirm(false);
      onChanged(next, kind === 'discard' ? `${item.name} was discarded.` : kind === 'retry' ? `${item.name} is back in the queue.` : `${item.name} was let through and is being filed.`);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="mi-card" data-testid="personal-inbox-item" data-state={item.state} data-item-id={item.id} aria-busy={busy !== null || undefined}>
      <div className="mi-card-main">
        <div className="mi-card-title">
          <strong className="mi-name" data-testid="personal-inbox-item-name">{item.name}</strong>
          <span className={`mi-state ${look.tone}`} data-testid="personal-inbox-item-state" data-state={look.label}>{look.label}</span>
        </div>
        <div className="mi-meta">
          <span>{kindLabel(item.kind)}</span>
          <span>{originLabel(item.origin)}</span>
          <span>{sizeLabel(item.size)}</span>
          <Time iso={item.createdAt} />
        </div>
        {sentence ? <p className="mi-sentence" data-testid="personal-inbox-item-sentence">{sentence}</p> : null}

        {item.state === 'filed' ? (
          <div className="mi-became" data-testid="personal-inbox-item-became">
            <span className="mi-became-head">{files.length > 0 ? `Became ${String(files.length)} ${files.length === 1 ? 'file' : 'files'}` : 'Filed as a reference only'}</span>
            {files.length > 0 ? (
              <ul className="mi-links">
                {files.map((p) => (
                  <li key={p}>
                    <Link to={personalConceptLink(p)} data-testid="personal-inbox-concept-link">{titleFor(titles, p) ?? conceptName(p)}</Link>
                  </li>
                ))}
              </ul>
            ) : null}
            {reference ? (
              <p className="mi-ref">
                <Link to={personalConceptLink(reference)} data-testid="personal-inbox-reference-link">The reference</Link> keeps the text and says where the original is.
              </p>
            ) : null}
          </div>
        ) : null}
        {error ? <p className="mi-error" role="alert" data-testid="personal-inbox-item-error">{error}</p> : null}
      </div>

      {can.retry || can.release || can.discard || can.sendToTeam ? (
        <div className="mi-actions">
          {can.sendToTeam ? <button type="button" className="btn s" disabled={busy !== null} onClick={() => onSendToTeam(item)} aria-label={`Send ${item.name} to a team`} data-testid="personal-inbox-send-to-team">Send to team</button> : null}
          {can.retry ? <button type="button" className="btn s" disabled={busy !== null} onClick={() => void run('retry')} aria-label={`Retry ${item.name}`} data-testid="personal-inbox-retry">{busy === 'retry' ? 'Retrying…' : 'Retry'}</button> : null}
          {can.release ? <button type="button" className="btn s primary" disabled={busy !== null} onClick={() => void run('release')} aria-label={`Let ${item.name} through`} data-testid="personal-inbox-release">{busy === 'release' ? 'Letting through…' : 'Let it through'}</button> : null}
          {can.discard && !confirm ? <button ref={discardBtn} type="button" className="btn s" disabled={busy !== null} onClick={() => setConfirm(true)} aria-label={`Discard ${item.name}`} data-testid="personal-inbox-discard">Discard</button> : null}
          {can.discard && confirm ? (
            <span className="mi-confirm" role="group" aria-label={`Discard ${item.name}?`}>
              <span>The original is deleted.</span>
              <button type="button" className="btn s danger" disabled={busy !== null} onClick={() => void run('discard')} data-testid="personal-inbox-discard-confirm">{busy === 'discard' ? 'Discarding…' : 'Discard it'}</button>
              <button ref={keepBtn} type="button" className="btn s" disabled={busy !== null} onClick={() => setConfirm(false)}>Keep it</button>
            </span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
