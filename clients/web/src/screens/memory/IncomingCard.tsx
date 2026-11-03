import { useId, useState } from 'react';
import { Link } from 'react-router';
import type { ShareIncoming } from '@manythreads/shared';
import { Time } from '../../components/ui';
import { announceApprovalsChanged } from '../approvals/live';
import { message } from './inboxWords';
import { actOnIncoming, decideRequest } from './shareApi';
import { CHOICE_WORDS, digestStateWords, incomingChoices, incomingLook, incomingSentence, modeWords, type IncomingChoice } from './shareWords';

type Digest = { period: string; state: Parameters<typeof digestStateWords>[0]; at: string; concepts: number; reason: string | null };

type Props = {
  slug: string;
  link: ShareIncoming;
  canManage: boolean;
  /** The digests this sender delivered, newest first (the "Received from" list); empty for a request. */
  digests?: readonly Digest[];
  /** How many concepts in this team's memory came from the sender. */
  concepts?: number;
  onChanged: (said: string) => void;
};

/**
 * One share another team sends to this one. While it is only a request, Accept and Decline answer it (the same answer the Approvals row takes); once open,
 * Pause, Resume and Stop receiving. Everyone on the team reads it; only a lead or a workspace admin changes it.
 */
export function IncomingCard({ slug, link, canManage, digests = [], concepts = 0, onChanged }: Props) {
  const headId = useId();
  const [busy, setBusy] = useState<IncomingChoice | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const look = incomingLook(link);
  const { choices, why } = incomingChoices(link, canManage);
  const isRequest = link.state === 'requested';

  const run = async (choice: IncomingChoice): Promise<void> => {
    if (choice === 'end' && !confirmEnd) {
      setConfirmEnd(true);
      return;
    }
    setBusy(choice);
    setError(null);
    try {
      if (choice === 'accept' || choice === 'decline') {
        if (!link.approvalId) throw new Error('The request is not in Approvals yet.');
        await decideRequest(slug, link.approvalId, choice === 'accept' ? 'approve' : 'deny');
        announceApprovalsChanged();
      } else {
        await actOnIncoming(slug, link.id, choice === 'pause' ? 'pause' : choice === 'resume' ? 'resume' : 'revoke');
      }
      setConfirmEnd(false);
      onChanged(CHOICE_WORDS[choice].done(link.fromName));
    } catch (e) {
      setError(message(e, 'That did not work. Try again.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="ms-card" data-testid={isRequest ? 'share-request' : 'share-received'} data-link={link.id} data-from={link.fromSlug} data-state={link.state} aria-labelledby={headId} aria-busy={busy !== null || undefined}>
      <div className="ms-card-main">
        <div className="ms-card-title">
          <strong id={headId} className="ms-name" data-testid="incoming-title">{isRequest ? `${link.fromName} asks to share “${link.shareName}”` : `Received from ${link.fromName}`}</strong>
          <span className={`mi-state ${look.tone}`} data-testid="incoming-state" data-state={link.state}>
            <span aria-hidden="true">{look.glyph}</span> {look.label}
          </span>
          <span className="mi-chip">{modeWords(link.mode)}</span>
        </div>
        {!isRequest ? <p className="ms-share-name" data-testid="incoming-share">{link.shareName}</p> : null}
        <p className="mi-sentence" data-testid="incoming-sentence">{incomingSentence(link)}</p>
        {link.lastDeliveredAt ? (
          <p className="mi-meta">
            <span>Last digest arrived <Time iso={link.lastDeliveredAt} /></span>
          </p>
        ) : null}

        {!isRequest && link.deliveries > 0 ? (
          <div className="ms-digests" data-testid="incoming-digests">
            {digests.length > 0 ? (
              <ul className="ms-digest-list" aria-label={`Digests from ${link.fromName}`}>
                {digests.slice(0, 5).map((d) => (
                  <li key={`${d.period}-${d.at}`} className="ms-digest" data-testid="incoming-digest">
                    <span className="mono">{d.period}</span>
                    <span>{digestStateWords(d.state)}</span>
                    {d.state === 'filed' && d.concepts > 0 ? <span>{String(d.concepts)} {d.concepts === 1 ? 'concept' : 'concepts'}</span> : null}
                    {d.reason && d.state !== 'filed' ? <span className="faint">{d.reason}</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {concepts > 0 ? (
              <p className="ms-hint" data-testid="incoming-concepts">
                {String(concepts)} {concepts === 1 ? 'concept' : 'concepts'} from {link.fromName} {concepts === 1 ? 'is' : 'are'} in this team’s memory, marked as shared from them. <Link to={`/t/${encodeURIComponent(slug)}/memory`}>See the concepts</Link>
              </p>
            ) : null}
          </div>
        ) : null}
        {why ? <p className="ms-why" data-testid="incoming-why">{why}</p> : null}
        {error ? <p className="mi-error" role="alert" data-testid="incoming-error">{error}</p> : null}
        {isRequest && link.approvalId ? (
          <p className="ms-hint">
            The same request is in <Link to={`/t/${encodeURIComponent(slug)}/approvals?approval=${link.approvalId}`} data-testid="incoming-approval-link">Approvals</Link>.
          </p>
        ) : null}
      </div>

      {choices.length > 0 ? (
        <div className="mi-actions" role="group" aria-label={`Answer ${link.fromName}`}>
          {choices.map((c) =>
            c === 'end' && confirmEnd ? (
              <span key={c} className="mi-confirm" role="group" aria-label={`Stop receiving from ${link.fromName}?`}>
                <span>It stays ended unless they send a new share.</span>
                <button type="button" className="btn s danger" disabled={busy !== null} onClick={() => void run('end')} data-testid="incoming-end-confirm">{busy === 'end' ? CHOICE_WORDS.end.busy : 'Stop receiving'}</button>
                <button type="button" className="btn s" disabled={busy !== null} onClick={() => setConfirmEnd(false)}>Keep receiving</button>
              </span>
            ) : (
              <button
                key={c}
                type="button"
                className={`btn s ${c === 'accept' ? 'primary' : ''}`}
                disabled={busy !== null}
                aria-label={`${CHOICE_WORDS[c].label} ${link.fromName}’s share ${link.shareName}`}
                onClick={() => void run(c)}
                data-testid={`incoming-${c}`}
              >
                {busy === c ? CHOICE_WORDS[c].busy : CHOICE_WORDS[c].label}
              </button>
            ),
          )}
        </div>
      ) : null}
    </li>
  );
}
