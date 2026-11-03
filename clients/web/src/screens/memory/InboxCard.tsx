import { useState } from 'react';
import { Link } from 'react-router';
import type { InboxItem } from '@manythreads/shared';
import { Time } from '../../components/ui';
import { InboxActions } from './InboxActions';
import { discardInboxItem, releaseInboxItem, retryInboxItem } from './inboxApi';
import { conceptLink, conceptName, filedConcepts, filedReference, hasActionItems, itemActions, itemLook, itemSentence, kindLabel, message, originLabel, sizeLabel } from './inboxWords';

type Props = {
  slug: string;
  item: InboxItem;
  canManage: boolean;
  /** Concept titles by path, when the concepts could be read (a path with no title shows its file name). */
  titles: ReadonlyMap<string, string>;
  /** Concept types by path, to know which of the item's concepts hold action items. */
  types: ReadonlyMap<string, string>;
  /** After an action: the item as the server now has it. */
  onChanged: (item: InboxItem, said: string) => void;
};

/**
 * One drop in the queue: its name, where it stands, what it became (links to the concepts it wrote) and, for a team lead or a workspace admin, Retry,
 * Release and Discard. A discard deletes the original, so it asks first.
 */
export function InboxCard({ slug, item, canManage, titles, types, onChanged }: Props) {
  const look = itemLook(item);
  const can = itemActions(item, canManage);
  const [busy, setBusy] = useState<null | 'retry' | 'release' | 'discard'>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const concepts = filedConcepts(item);
  const reference = filedReference(item);
  const sentence = itemSentence(item);

  const run = async (kind: 'retry' | 'release' | 'discard'): Promise<void> => {
    setBusy(kind);
    setError(null);
    try {
      const act = kind === 'retry' ? retryInboxItem : kind === 'release' ? releaseInboxItem : discardInboxItem;
      const { item: next } = await act(slug, item.id);
      setConfirm(false);
      onChanged(next, kind === 'discard' ? `${item.name} was discarded.` : kind === 'retry' ? `${item.name} is back in the queue.` : `${item.name} was released and is being filed.`);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="mi-card" data-testid="inbox-item" data-state={item.state} data-item-id={item.id} aria-busy={busy !== null || undefined}>
      <div className="mi-card-main">
        <div className="mi-card-title">
          <strong className="mi-name" data-testid="inbox-item-name">{item.name}</strong>
          <span className={`mi-state ${look.tone}`} data-testid="inbox-item-state" data-state={look.label}>
            <span aria-hidden="true">{look.glyph}</span> {look.label}
          </span>
          {item.teamOnly ? <span className="mi-chip" data-testid="inbox-item-team-only">Team only</span> : null}
        </div>
        <div className="mi-meta">
          <span>{kindLabel(item.kind)}</span>
          <span>{originLabel(item.origin)}{item.droppedByName ? ` by ${item.droppedByName}` : item.sender ? ` by ${item.sender}` : ''}</span>
          <span>{sizeLabel(item.size)}</span>
          <Time iso={item.createdAt} />
        </div>
        {sentence ? <p className="mi-sentence" data-testid="inbox-item-sentence">{sentence}</p> : null}

        {item.state === 'filed' ? (
          <div className="mi-became" data-testid="inbox-item-became">
            <span className="mi-became-head">{concepts.length > 0 ? `Became ${String(concepts.length)} ${concepts.length === 1 ? 'concept' : 'concepts'}` : 'Filed as a reference only'}</span>
            {concepts.length > 0 ? (
              <ul className="mi-links">
                {concepts.map((p) => (
                  <li key={p}>
                    <Link to={conceptLink(slug, p)} data-testid="inbox-concept-link">{titles.get(p) ?? conceptName(p)}</Link>
                  </li>
                ))}
              </ul>
            ) : null}
            {hasActionItems(concepts, types) ? <InboxActions slug={slug} itemId={item.id} /> : null}
            {reference ? (
              <p className="mi-ref">
                <Link to={conceptLink(slug, reference)} data-testid="inbox-reference-link">The reference</Link> keeps the full text and says where the original is.
              </p>
            ) : null}
          </div>
        ) : null}
        {item.state === 'held' && !canManage ? <p className="mi-sentence faint">A team lead or a workspace admin decides what happens next.</p> : null}
        {error ? <p className="mi-error" role="alert" data-testid="inbox-item-error">{error}</p> : null}
      </div>

      {can.retry || can.release || can.discard ? (
        <div className="mi-actions">
          {can.retry ? <button type="button" className="btn s" disabled={busy !== null} onClick={() => void run('retry')} aria-label={`Retry ${item.name}`} data-testid="inbox-retry">{busy === 'retry' ? 'Retrying…' : 'Retry'}</button> : null}
          {can.release ? <button type="button" className="btn s primary" disabled={busy !== null} onClick={() => void run('release')} aria-label={`Release ${item.name}`} data-testid="inbox-release">{busy === 'release' ? 'Releasing…' : 'Release'}</button> : null}
          {can.discard && !confirm ? <button type="button" className="btn s" disabled={busy !== null} onClick={() => setConfirm(true)} aria-label={`Discard ${item.name}`} data-testid="inbox-discard">Discard</button> : null}
          {can.discard && confirm ? (
            <span className="mi-confirm" role="group" aria-label={`Discard ${item.name}?`}>
              <span>The original is deleted.</span>
              <button type="button" className="btn s danger" disabled={busy !== null} onClick={() => void run('discard')} data-testid="inbox-discard-confirm">{busy === 'discard' ? 'Discarding…' : 'Discard it'}</button>
              <button type="button" className="btn s" disabled={busy !== null} onClick={() => setConfirm(false)}>Keep it</button>
            </span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
