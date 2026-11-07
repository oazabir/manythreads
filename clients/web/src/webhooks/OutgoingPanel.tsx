import { useState, type FormEvent } from 'react';
import type { OutgoingHook, OutgoingMatch } from '@manythreads/shared';
import {
  clearOutgoingSigningSecret,
  createOutgoingHook,
  fetchOutgoingHooks,
  revokeOutgoingHook,
  sendOutgoingHookTest,
  setOutgoingSigningSecret,
  updateOutgoingHook,
} from '../api/endpoints';
import { useQuery } from '../app/useQuery';
import { CopyBox } from './CopyBox';
import { VERIFY_EXAMPLE, deliveryLine, errorWords, messageOf, parseTriggerWords } from './model';
import { SkeletonRows } from '../components/Skeleton';

/*
 * Outgoing webhooks of one channel (PLAN P14-14). A lead picks some trigger words and an address. When a person's message starts with, or contains, one of
 * the words, the server sends it to the address; if the program answers with some text, that text is posted back here once, under the webhook's name.
 */

type Note = { ok: boolean; text: string };
interface Reveal {
  name: string;
  secret: string;
}

const MATCH_LABELS: Record<OutgoingMatch, string> = { starts: 'starts with a trigger word', contains: 'contains a trigger word' };

function HookRow({ hook, onChange, onShow, onNote }: { hook: OutgoingHook; onChange: () => void; onShow: (r: Reveal) => void; onNote: (n: Note) => void }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(hook.url);
  const [words, setWords] = useState(hook.triggerWords.join(', '));
  const [match, setMatch] = useState<OutgoingMatch>(hook.match);
  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await work();
    } catch (err) {
      onNote({ ok: false, text: messageOf(err) });
    } finally {
      setBusy(false);
    }
  };
  const label = hook.emoji ? `${hook.emoji} ${hook.name}` : hook.name;
  const save = (e: FormEvent): void => {
    e.preventDefault();
    void run(async () => {
      const list = parseTriggerWords(words);
      if (list.length === 0) throw new Error('Give at least one trigger word.');
      await updateOutgoingHook(hook.id, { url: url.trim(), triggerWords: list, match });
      onNote({ ok: true, text: `"${hook.name}" was changed.` });
      setEditing(false);
      onChange();
    });
  };
  return (
    <li className="wh-row" data-testid="outgoing-row" data-hook-id={hook.id}>
      <div className="wh-row-main">
        <span className="wh-name">{label}</span>
        <span className="chip" title="Replies it posts carry this mark">Webhook</span>
        {hook.enabled ? null : <span className="chip" title="Nothing is sent while it is paused">Paused</span>}
        {hook.signed ? <span className="chip ok" title="Each call carries a signature">Signed</span> : null}
      </div>
      <p className="wh-addr">
        Sends to <span className="wh-mono">{hook.url}</span> when a message {MATCH_LABELS[hook.match]}:{' '}
        {hook.triggerWords.map((w) => (
          <span key={w} className="chip wh-word">{w}</span>
        ))}
      </p>
      <p className="wh-use">{deliveryLine(hook)}</p>
      <p className="wh-use">
        The call carries <span className="wh-mono">token</span> <span className="wh-mono" data-testid="outgoing-verification">{hook.verificationToken}</span> so the program can tell it is for this
        webhook.
      </p>
      {editing ? (
        <form className="wh-form wh-edit" onSubmit={save} aria-label={`Change ${hook.name}`}>
          <div className="wh-field wh-field-wide">
            <label className="dlg-label" htmlFor={`wh-out-url-${hook.id}`}>Address</label>
            <input id={`wh-out-url-${hook.id}`} className="dlg-input" value={url} maxLength={2000} onChange={(e) => setUrl(e.target.value)} autoComplete="off" inputMode="url" />
          </div>
          <div className="wh-field wh-field-wide">
            <label className="dlg-label" htmlFor={`wh-out-words-${hook.id}`}>Trigger words (separate with commas)</label>
            <input id={`wh-out-words-${hook.id}`} className="dlg-input" value={words} onChange={(e) => setWords(e.target.value)} autoComplete="off" />
          </div>
          <div className="wh-field">
            <label className="dlg-label" htmlFor={`wh-out-match-${hook.id}`}>Send when a message</label>
            <select id={`wh-out-match-${hook.id}`} className="dlg-input" value={match} onChange={(e) => setMatch(e.target.value as OutgoingMatch)}>
              <option value="starts">starts with a trigger word</option>
              <option value="contains">contains a trigger word</option>
            </select>
          </div>
          <button type="submit" className="btn primary" disabled={busy}>Save</button>
          <button type="button" className="btn" onClick={() => setEditing(false)}>Cancel</button>
        </form>
      ) : null}
      <div className="wh-actions">
        <button
          type="button"
          className="btn"
          disabled={busy}
          data-testid="outgoing-test"
          title="Sends one sample message to the address now. Nothing is posted in the channel."
          onClick={() =>
            void run(async () => {
              const r = await sendOutgoingHookTest(hook.id);
              onNote(
                r.delivered
                  ? { ok: true, text: `The test reached "${hook.name}" (answer ${r.statusCode ?? 200})${r.wouldReply ? ' and it replied with a message.' : ' and it did not reply with a message.'}` }
                  : { ok: false, text: `The test did not get through: ${errorWords(r.reason)}.` },
              );
              onChange();
            })
          }
        >
          Send test call
        </button>
        <button type="button" className="btn" disabled={busy} data-testid="outgoing-edit" onClick={() => setEditing((v) => !v)} aria-expanded={editing}>Change</button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          data-testid="outgoing-toggle"
          onClick={() =>
            void run(async () => {
              await updateOutgoingHook(hook.id, { enabled: !hook.enabled });
              onNote({ ok: true, text: hook.enabled ? `"${hook.name}" is paused.` : `"${hook.name}" is on again.` });
              onChange();
            })
          }
        >
          {hook.enabled ? 'Pause' : 'Turn on'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          data-testid="outgoing-signing"
          title="Each call then carries a signature the program can check, so it knows the call is really from here."
          onClick={() =>
            void run(async () => {
              const made = await setOutgoingSigningSecret(hook.id);
              onShow({ name: hook.name, secret: made.signingSecret });
              onChange();
            })
          }
        >
          {hook.signed ? 'New signing secret' : 'Add signing secret'}
        </button>
        {hook.signed ? (
          <button
            type="button"
            className="btn quiet"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await clearOutgoingSigningSecret(hook.id);
                onNote({ ok: true, text: `"${hook.name}" no longer signs its calls.` });
                onChange();
              })
            }
          >
            Remove signing secret
          </button>
        ) : null}
        {confirming ? (
          <span className="wh-confirm" role="group" aria-label={`Switch off ${hook.name}`}>
            <span>Switch it off for good?</span>
            <button
              type="button"
              className="btn wh-danger"
              disabled={busy}
              data-testid="outgoing-revoke-confirm"
              onClick={() =>
                void run(async () => {
                  await revokeOutgoingHook(hook.id);
                  onNote({ ok: true, text: `"${hook.name}" was switched off.` });
                  setConfirming(false);
                  onChange();
                })
              }
            >
              Yes, switch off
            </button>
            <button type="button" className="btn" onClick={() => setConfirming(false)}>Keep it</button>
          </span>
        ) : (
          <button type="button" className="btn quiet wh-danger-text" disabled={busy} data-testid="outgoing-revoke" onClick={() => setConfirming(true)}>Switch off</button>
        )}
      </div>
    </li>
  );
}

export function OutgoingPanel({ channelId }: { channelId: string }) {
  const list = useQuery(`outgoing-hooks:${channelId}`, () => fetchOutgoingHooks(channelId));
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [words, setWords] = useState('');
  const [match, setMatch] = useState<OutgoingMatch>('starts');
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<Reveal | null>(null);
  const [note, setNote] = useState<Note | null>(null);

  const triggerWords = parseTriggerWords(words);
  const ready = name.trim() !== '' && url.trim() !== '' && triggerWords.length > 0;
  const create = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault();
    if (!ready) return;
    setBusy(true);
    setNote(null);
    try {
      const made = await createOutgoingHook(channelId, { name: name.trim(), url: url.trim(), triggerWords, match });
      setNote({ ok: true, text: `"${made.name}" is on. A message that ${MATCH_LABELS[made.match]} will be sent to the address.` });
      setName('');
      setUrl('');
      setWords('');
      list.reload();
    } catch (err) {
      setNote({ ok: false, text: messageOf(err) });
    } finally {
      setBusy(false);
    }
  };

  const hooks = list.status === 'ok' ? list.data.hooks : [];
  return (
    <>
      <p className="wh-lead">
        An outgoing webhook sends a message out. Pick some trigger words and the address of a program. When a person writes a message that starts with (or contains) one of
        the words, the server sends it to that address. If the program answers with some text, the text is posted here, once, under the webhook&rsquo;s name. Messages
        from a webhook or a bot never trigger one. The address must be public: a server cannot call into a private network.
      </p>

      {shown ? (
        <div className="wh-reveal" role="status" data-testid="outgoing-reveal">
          <p className="wh-reveal-title">Signing secret for &ldquo;{shown.name}&rdquo;. Copy it now: it is shown only once.</p>
          <CopyBox value={shown.secret} label="Signing secret" testId="outgoing-signing-value" />
          <p className="wh-hint">The program checks each call with it. This is how, in Node:</p>
          <pre className="wh-pre">{VERIFY_EXAMPLE}</pre>
          <button type="button" className="btn" onClick={() => setShown(null)}>I have copied it</button>
        </div>
      ) : null}

      {note ? <p className={note.ok ? 'wh-note' : 'dlg-error'} role={note.ok ? 'status' : 'alert'} data-testid="outgoing-note">{note.text}</p> : null}

      <h3 className="wh-h">Outgoing webhooks in this channel</h3>
      {list.status === 'loading' ? <SkeletonRows rows={2} label="Loading" /> : null}
      {list.status === 'error' ? <p className="dlg-error" role="alert">{list.error.message}</p> : null}
      {list.status === 'ok' && hooks.length === 0 ? <p className="wh-hint" data-testid="outgoing-empty">None yet. Make one below.</p> : null}
      {hooks.length > 0 ? (
        <ul className="wh-list">
          {hooks.map((h) => (
            <HookRow key={h.id} hook={h} onChange={list.reload} onShow={setShown} onNote={setNote} />
          ))}
        </ul>
      ) : null}

      <h3 className="wh-h">Make an outgoing webhook</h3>
      <form className="wh-form" onSubmit={(e) => void create(e)}>
        <div className="wh-field wh-field-name">
          <label className="dlg-label" htmlFor="wh-out-name">Name</label>
          <input id="wh-out-name" className="dlg-input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Deploy bot" autoComplete="off" data-testid="outgoing-name" />
        </div>
        <div className="wh-field wh-field-wide">
          <label className="dlg-label" htmlFor="wh-out-url">Address to send to</label>
          <input id="wh-out-url" className="dlg-input" value={url} maxLength={2000} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/deploy" autoComplete="off" inputMode="url" data-testid="outgoing-url" />
        </div>
        <div className="wh-field wh-field-wide">
          <label className="dlg-label" htmlFor="wh-out-words">Trigger words (separate with commas)</label>
          <input id="wh-out-words" className="dlg-input" value={words} onChange={(e) => setWords(e.target.value)} placeholder="deploy, !ship" autoComplete="off" data-testid="outgoing-words" />
        </div>
        <div className="wh-field">
          <label className="dlg-label" htmlFor="wh-out-match">Send when a message</label>
          <select id="wh-out-match" className="dlg-input" value={match} onChange={(e) => setMatch(e.target.value as OutgoingMatch)} data-testid="outgoing-match">
            <option value="starts">starts with a trigger word</option>
            <option value="contains">contains a trigger word</option>
          </select>
        </div>
        <button type="submit" className="btn primary" disabled={busy || !ready} data-testid="outgoing-create">Make webhook</button>
      </form>
      <p className="wh-hint">
        Each call is a JSON message like Slack&rsquo;s outgoing webhooks: <span className="wh-mono">token</span>, <span className="wh-mono">channel_name</span>,{' '}
        <span className="wh-mono">user_name</span>, <span className="wh-mono">text</span>, <span className="wh-mono">trigger_word</span> and{' '}
        <span className="wh-mono">timestamp</span>. The program has 5 seconds to answer; a failed call is tried again up to 5 times. The web ports 80 and 443 only.
      </p>
    </>
  );
}
