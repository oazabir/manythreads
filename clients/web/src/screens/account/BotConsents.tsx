import { useState } from 'react';
import type { BotPersonalConsent } from '@manythreads/shared';
import { PageHeader } from '../../components/PageHeader';
import { ForbiddenBody, QueryView } from '../../components/states';
import { Time } from '../../components/ui';
import { useSession } from '../../app/session';
import { useQuery } from '../../app/useQuery';
import { message } from '../memory/inboxWords';
import { fetchBotConsents, setBotConsent } from './botConsentsApi';

/** The one-line answer a row gives about a bot, in words (the switch beside it only repeats it). */
export function consentSentence(c: BotPersonalConsent): string {
  if (!c.canAsk) return 'This bot is not set up to ask for your Personal space, so it cannot read it whatever you choose here.';
  if (c.allowed) return c.isDefault ? 'May read your Personal space when you ask it. This is the default for Brain.' : 'May read your Personal space when you ask it.';
  return c.isDefault ? 'Cannot read your Personal space until you allow it.' : 'Cannot read your Personal space. You turned it off.';
}

/**
 * Account → Bots that may read your Personal space. A bot reads your Personal memory, files and knowledge only in a conversation you start with it, and only
 * while you have said yes here. A change counts from the bot's next step. Brain is allowed until you say no; every other bot needs your yes, and only a bot
 * whose definition asks for it is listed as able to use one.
 */
export function BotConsents() {
  // This page sits in the settings frame, outside the app shell, so the shell's context is not there: the role comes from the session.
  const guest = useSession().role === 'guest';
  // a guest has no Personal space; the page says so once (one heading), not under a second header
  if (guest) return <div className="inline-state"><ForbiddenBody /></div>;
  return <BotConsentsBody />;
}

function BotConsentsBody() {
  const q = useQuery('account-bot-consents', fetchBotConsents);
  return (
    <>
      <PageHeader title="Bots that may read your Personal space" description="Your Personal memory, files and knowledge are yours. A bot reads them only in a conversation you start with it, and only if you allow it here." />
      <section className="block" aria-labelledby="bc-list" data-testid="bot-consents">
        <h2 className="bh" id="bc-list">Bots</h2>
        <QueryView q={q}>
          {({ items }) =>
            items.length === 0 ? (
              <div className="block-body">
                <p className="d" data-testid="bot-consents-none">There are no bots in this workspace yet.</p>
              </div>
            ) : (
              <ul className="bc-list">
                {items.map((c) => (
                  <ConsentRow key={c.botId} consent={c} />
                ))}
              </ul>
            )
          }
        </QueryView>
      </section>
    </>
  );
}

function ConsentRow({ consent }: { consent: BotPersonalConsent }) {
  const [current, setCurrent] = useState(consent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = async (next: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { item } = await setBotConsent(current.botId, next);
      setCurrent(item);
    } catch (e) {
      setError(message(e, 'That could not be saved. Your choice is unchanged.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="bc-row" data-testid="bot-consent" data-bot={current.botSlug} data-allowed={current.allowed} data-can-ask={current.canAsk}>
      <div className="bc-main">
        <div className="bc-name">{current.botName}</div>
        <p className="bc-why" data-testid="bot-consent-sentence">
          {consentSentence(current)}
          {current.changedAt ? <> You changed this <Time iso={current.changedAt} />.</> : null}
        </p>
      </div>
      <div className="bc-answer">
        <span className="bc-state" role="status" data-testid="bot-consent-state">{current.allowed ? 'Allowed' : 'Not allowed'}</span>
        {current.allowed ? (
          <button type="button" className="btn s" disabled={busy} onClick={() => void set(false)} aria-label={`Turn off ${current.botName}`} data-testid="bot-consent-turn-off">{busy ? 'Saving…' : 'Turn off'}</button>
        ) : (
          <button type="button" className="btn s primary" disabled={busy || !current.canAsk} onClick={() => void set(true)} aria-label={`Allow ${current.botName}`} data-testid="bot-consent-allow">{busy ? 'Saving…' : 'Allow'}</button>
        )}
      </div>
      {error ? <p className="bc-error" role="alert" data-testid="bot-consent-error">{error}</p> : null}
    </li>
  );
}
