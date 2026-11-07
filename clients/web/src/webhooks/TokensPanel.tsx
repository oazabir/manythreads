import { useState, type FormEvent } from 'react';
import { SLACK_METHODS, type ApiToken } from '@manythreads/shared';
import { createApiToken, fetchApiTokens, revokeApiToken, rotateApiToken, sendApiTokenTest } from '../api/endpoints';
import { useQuery } from '../app/useQuery';
import { CopyBox } from './CopyBox';
import { METHOD_LABELS, messageOf, tokenCurlExample, tokenUseLine } from './model';
import { SkeletonRows } from '../components/Skeleton';

/*
 * API tokens of one channel (PLAN P14-14). A token lets a script use a small part of Slack's Web API (post, edit its own messages, react) against this
 * channel only, so tools written for Slack work here by changing the address. The secret is shown once; only a fingerprint is kept.
 */

interface Reveal {
  name: string;
  secret: string;
  channelId: string;
}
type Note = { ok: boolean; text: string };

function TokenRow({ token, onChange, onShow, onNote }: { token: ApiToken; onChange: () => void; onShow: (r: Reveal) => void; onNote: (n: Note) => void }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
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
  const label = token.emoji ? `${token.emoji} ${token.name}` : token.name;
  return (
    <li className="wh-row" data-testid="token-row" data-token-id={token.id}>
      <div className="wh-row-main">
        <span className="wh-name">{label}</span>
        <span className="chip" title="Messages it posts carry this mark">Webhook</span>
        {token.channelIds.length > 1 ? <span className="chip" title="It can reach more than this channel">{token.channelIds.length} channels</span> : null}
      </div>
      <p className="wh-use">{tokenUseLine(token)}</p>
      <p className="wh-addr">Allowed: {token.methods.map((m) => METHOD_LABELS[m] ?? m).join(', ')}</p>
      <div className="wh-actions">
        <button
          type="button"
          className="btn"
          disabled={busy}
          data-testid="token-test"
          onClick={() =>
            void run(async () => {
              await sendApiTokenTest(token.id);
              onNote({ ok: true, text: `A test message from "${token.name}" was posted in this channel.` });
              onChange();
            })
          }
        >
          Send test message
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          data-testid="token-rotate"
          title="Makes a new token. The old one stops working at once."
          onClick={() =>
            void run(async () => {
              const made = await rotateApiToken(token.id);
              onShow({ name: token.name, secret: made.secret, channelId: token.channelId });
              onChange();
            })
          }
        >
          New token
        </button>
        {confirming ? (
          <span className="wh-confirm" role="group" aria-label={`Switch off ${token.name}`}>
            <span>Switch it off for good?</span>
            <button
              type="button"
              className="btn wh-danger"
              disabled={busy}
              data-testid="token-revoke-confirm"
              onClick={() =>
                void run(async () => {
                  await revokeApiToken(token.id);
                  onNote({ ok: true, text: `"${token.name}" was switched off. Its token no longer works.` });
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
          <button type="button" className="btn quiet wh-danger-text" disabled={busy} data-testid="token-revoke" onClick={() => setConfirming(true)}>Switch off</button>
        )}
      </div>
    </li>
  );
}

export function TokensPanel({ channelId }: { channelId: string }) {
  const list = useQuery(`api-tokens:${channelId}`, () => fetchApiTokens(channelId));
  const [name, setName] = useState('');
  const [methods, setMethods] = useState<string[]>([...SLACK_METHODS]);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<Reveal | null>(null);
  const [note, setNote] = useState<Note | null>(null);

  const toggle = (m: string): void => setMethods((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m]));
  const create = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault();
    if (name.trim() === '' || methods.length === 0) return;
    setBusy(true);
    setNote(null);
    try {
      const made = await createApiToken(channelId, { name: name.trim(), methods: SLACK_METHODS.filter((m) => methods.includes(m)) });
      setShown({ name: made.token.name, secret: made.secret, channelId: made.token.channelId });
      setName('');
      list.reload();
    } catch (err) {
      setNote({ ok: false, text: messageOf(err) });
    } finally {
      setBusy(false);
    }
  };

  const tokens = list.status === 'ok' ? list.data.tokens : [];
  const base = list.status === 'ok' ? list.data.apiBase : 'https://your-site.example/api/slack/';
  return (
    <>
      <p className="wh-lead">
        An API token lets a script talk to this channel the way Slack&rsquo;s Web API does: post a message, edit a message it posted, add or remove a reaction. Tools
        written for Slack work here once you point them at this server&rsquo;s address and give them the token. A token works for this channel only (and the
        others of this team you pick), and it can be switched off at any time.
      </p>

      {shown ? (
        <div className="wh-reveal" role="status" data-testid="token-reveal">
          <p className="wh-reveal-title">Token for &ldquo;{shown.name}&rdquo;. Copy it now: it is shown only once.</p>
          <CopyBox value={shown.secret} label="API token" testId="token-secret" />
          <p className="wh-hint">Try it from a terminal:</p>
          <pre className="wh-pre" data-testid="token-curl">{tokenCurlExample(base, shown.secret, shown.channelId)}</pre>
          <button type="button" className="btn" onClick={() => setShown(null)}>I have copied it</button>
        </div>
      ) : null}

      {note ? <p className={note.ok ? 'wh-note' : 'dlg-error'} role={note.ok ? 'status' : 'alert'} data-testid="token-note">{note.text}</p> : null}

      <h3 className="wh-h">API tokens for this channel</h3>
      {list.status === 'loading' ? <SkeletonRows rows={2} label="Loading" /> : null}
      {list.status === 'error' ? <p className="dlg-error" role="alert">{list.error.message}</p> : null}
      {list.status === 'ok' && tokens.length === 0 ? <p className="wh-hint" data-testid="tokens-empty">None yet. Make one below.</p> : null}
      {tokens.length > 0 ? (
        <ul className="wh-list">
          {tokens.map((t) => (
            <TokenRow key={t.id} token={t} onChange={list.reload} onShow={setShown} onNote={setNote} />
          ))}
        </ul>
      ) : null}

      <h3 className="wh-h">Make an API token</h3>
      <form className="wh-form" onSubmit={(e) => void create(e)}>
        <div className="wh-field wh-field-name">
          <label className="dlg-label" htmlFor="wh-token-name">Name</label>
          <input id="wh-token-name" className="dlg-input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Deploy script" autoComplete="off" data-testid="token-name" />
        </div>
        <fieldset className="wh-methods">
          <legend className="dlg-label">What it may do</legend>
          {SLACK_METHODS.map((m) => (
            <label key={m} className="wh-check">
              <input type="checkbox" checked={methods.includes(m)} onChange={() => toggle(m)} data-testid={`token-method-${m}`} />
              <span>{METHOD_LABELS[m] ?? m}</span>
            </label>
          ))}
        </fieldset>
        <button type="submit" className="btn primary" disabled={busy || name.trim() === '' || methods.length === 0} data-testid="token-create">Make token</button>
      </form>
      <p className="wh-hint">The name is what the channel shows as the author of each message, with a Webhook mark. At most 20 integrations per channel, and 60 calls a minute for each token.</p>

      <details className="wh-help">
        <summary>How to use a token</summary>
        <p>Send the token in an <span className="wh-mono">Authorization: Bearer</span> header to <span className="wh-mono">{base}</span> followed by the method name.</p>
        <ul className="wh-points">
          <li><span className="wh-mono">chat.postMessage</span>: <span className="wh-mono">channel</span> (the channel&rsquo;s id or its name), <span className="wh-mono">text</span> or <span className="wh-mono">blocks</span>, and <span className="wh-mono">thread_ts</span> to reply in a thread.</li>
          <li><span className="wh-mono">chat.update</span>: <span className="wh-mono">channel</span>, <span className="wh-mono">ts</span> and the new <span className="wh-mono">text</span>. Only messages this token posted can be edited.</li>
          <li><span className="wh-mono">reactions.add</span> and <span className="wh-mono">reactions.remove</span>: <span className="wh-mono">channel</span>, <span className="wh-mono">timestamp</span> and <span className="wh-mono">name</span> (such as <span className="wh-mono">thumbsup</span>).</li>
          <li><span className="wh-mono">auth.test</span>: says whose token it is and which channels it reaches.</li>
          <li>Answers look like Slack&rsquo;s: <span className="wh-mono">{'{"ok": true, "ts": "…"}'}</span> or <span className="wh-mono">{'{"ok": false, "error": "…"}'}</span>. Mentions such as @here in the text notify nobody.</li>
        </ul>
      </details>
    </>
  );
}
