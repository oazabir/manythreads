import { useState, type FormEvent } from 'react';
import type { Webhook } from '@manythreads/shared';
import { clearWebhookSigningSecret, createWebhook, fetchWebhooks, revokeWebhook, rotateWebhook, sendWebhookTest, setWebhookSigningSecret } from '../api/endpoints';
import { useQuery } from '../app/useQuery';
import { Dialog } from '../components/Dialog';
import { HookIcon } from '../shell/icons';
import { PLACEHOLDER_URL, curlExample, useLine } from './model';

/*
 * The webhooks of one channel (PLAN P14-14): a lead makes a secret web address, copies it once, and points a build server, GitHub or a script at it.
 * Everything a lead needs is in this one dialog: make, test, change the address, add a signing secret, switch one off, and how to call it.
 */

type Shown = { kind: 'address'; webhookId: string; name: string; value: string } | { kind: 'signing'; webhookId: string; name: string; value: string };

const messageOf = (err: unknown): string => (err instanceof Error && err.message ? err.message : 'That did not work. Try again.');

function CopyBox({ value, label, testId }: { value: string; label: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_500);
      } catch {
        // the clipboard may be blocked; the text stays selectable
      }
    })();
  };
  return (
    <div className="wh-copy">
      <code className="wh-copy-value" data-testid={testId} tabIndex={0} aria-label={label}>{value}</code>
      <button type="button" className="btn" onClick={copy} data-testid={`${testId}-copy`}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

function HookRow({ hook, base, onChange, onShow, onNote }: { hook: Webhook; base: string; onChange: () => void; onShow: (s: Shown) => void; onNote: (n: { ok: boolean; text: string }) => void }) {
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
  const label = hook.emoji ? `${hook.emoji} ${hook.name}` : hook.name;
  return (
    <li className="wh-row" data-testid="webhook-row" data-webhook-id={hook.id}>
      <div className="wh-row-main">
        <span className="wh-name">{label}</span>
        <span className="chip" title="Messages it posts carry this mark">Webhook</span>
        {hook.signed ? <span className="chip ok" title="Calls must carry a valid signature">Signed</span> : null}
      </div>
      <p className="wh-use">{useLine(hook)}</p>
      <p className="wh-addr">Address: <span className="wh-mono">{base}{hook.id.slice(0, 8)}…/••••••••</span> (the secret part is shown only when it is made)</p>
      <div className="wh-actions">
        <button
          type="button"
          className="btn"
          disabled={busy}
          data-testid="webhook-test"
          onClick={() =>
            void run(async () => {
              await sendWebhookTest(hook.id);
              onNote({ ok: true, text: `A test message from "${hook.name}" was posted in this channel.` });
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
          data-testid="webhook-rotate"
          title="Makes a new secret address. The old one stops working at once."
          onClick={() =>
            void run(async () => {
              const made = await rotateWebhook(hook.id);
              onShow({ kind: 'address', webhookId: hook.id, name: hook.name, value: made.url });
              onChange();
            })
          }
        >
          New address
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          data-testid="webhook-signing"
          title="GitHub can sign each call with a shared secret; the webhook then refuses calls that are not signed."
          onClick={() =>
            void run(async () => {
              const made = await setWebhookSigningSecret(hook.id);
              onShow({ kind: 'signing', webhookId: hook.id, name: hook.name, value: made.signingSecret });
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
                await clearWebhookSigningSecret(hook.id);
                onNote({ ok: true, text: `"${hook.name}" no longer needs signed calls.` });
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
              data-testid="webhook-revoke-confirm"
              onClick={() =>
                void run(async () => {
                  await revokeWebhook(hook.id);
                  onNote({ ok: true, text: `"${hook.name}" was switched off. Its address no longer works.` });
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
          <button type="button" className="btn quiet wh-danger-text" disabled={busy} data-testid="webhook-revoke" onClick={() => setConfirming(true)}>Switch off</button>
        )}
      </div>
    </li>
  );
}

export function WebhooksDialog({ channelId, channelName, onClose }: { channelId: string; channelName: string; onClose: () => void }) {
  const list = useQuery(`webhooks:${channelId}`, () => fetchWebhooks(channelId));
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('');
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const create = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault();
    if (name.trim() === '') return;
    setBusy(true);
    setNote(null);
    try {
      const made = await createWebhook(channelId, { name: name.trim(), ...(emoji.trim() !== '' ? { emoji: emoji.trim() } : {}) });
      setShown({ kind: 'address', webhookId: made.webhook.id, name: made.webhook.name, value: made.url });
      setName('');
      setEmoji('');
      list.reload();
    } catch (err) {
      setNote({ ok: false, text: messageOf(err) });
    } finally {
      setBusy(false);
    }
  };

  const hooks = list.status === 'ok' ? list.data.webhooks : [];
  const base = list.status === 'ok' ? list.data.base : '';
  return (
    <Dialog title={`Webhooks for #${channelName}`} onClose={onClose} testId="webhooks-dialog" wide footer={<button type="button" className="btn primary" onClick={onClose}>Done</button>}>
      <p className="wh-lead">
        A webhook is a private web address. When a program sends a message to it, such as a build server, GitHub or a script of yours, the message appears
        in this channel, written by the webhook&rsquo;s name. Anyone who has the address can post here, so keep it secret.
      </p>

      {shown ? (
        <div className="wh-reveal" role="status" data-testid="webhook-reveal">
          {shown.kind === 'address' ? (
            <>
              <p className="wh-reveal-title">Address for &ldquo;{shown.name}&rdquo;. Copy it now: it is shown only once.</p>
              <CopyBox value={shown.value} label="Webhook address" testId="webhook-url" />
              <p className="wh-hint">Try it from a terminal:</p>
              <pre className="wh-pre" data-testid="webhook-curl">{curlExample(shown.value)}</pre>
            </>
          ) : (
            <>
              <p className="wh-reveal-title">Signing secret for &ldquo;{shown.name}&rdquo;. Copy it now: it is shown only once.</p>
              <CopyBox value={shown.value} label="Signing secret" testId="webhook-signing-value" />
              <p className="wh-hint">
                In GitHub, open the repository&rsquo;s Settings, then Webhooks, and paste this into the &ldquo;Secret&rdquo; box. From now on the webhook
                refuses calls that are not signed with it.
              </p>
            </>
          )}
          <button type="button" className="btn" onClick={() => setShown(null)}>I have copied it</button>
        </div>
      ) : null}

      {note ? <p className={note.ok ? 'wh-note' : 'dlg-error'} role={note.ok ? 'status' : 'alert'} data-testid="webhook-note">{note.text}</p> : null}

      <h3 className="wh-h">Webhooks in this channel</h3>
      {list.status === 'loading' ? <p className="wh-hint" aria-busy="true">Loading…</p> : null}
      {list.status === 'error' ? <p className="dlg-error" role="alert">{list.error.message}</p> : null}
      {list.status === 'ok' && hooks.length === 0 ? <p className="wh-hint" data-testid="webhooks-empty">None yet. Make one below.</p> : null}
      {hooks.length > 0 ? (
        <ul className="wh-list">
          {hooks.map((h) => (
            <HookRow key={h.id} hook={h} base={base} onChange={list.reload} onShow={setShown} onNote={setNote} />
          ))}
        </ul>
      ) : null}

      <h3 className="wh-h">Make a webhook</h3>
      <form className="wh-form" onSubmit={(e) => void create(e)}>
        <div className="wh-field wh-field-name">
          <label className="dlg-label" htmlFor="wh-name">Name</label>
          <input id="wh-name" className="dlg-input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="GitHub Actions" autoComplete="off" data-testid="webhook-name" />
        </div>
        <div className="wh-field wh-field-emoji">
          <label className="dlg-label" htmlFor="wh-emoji">Emoji (optional)</label>
          <input id="wh-emoji" className="dlg-input" value={emoji} maxLength={16} onChange={(e) => setEmoji(e.target.value)} placeholder="🚦" autoComplete="off" data-testid="webhook-emoji" />
        </div>
        <button type="submit" className="btn primary" disabled={busy || name.trim() === ''} data-testid="webhook-create">Make webhook</button>
      </form>
      <p className="wh-hint">The name is what the channel shows as the author of each message, with a Webhook mark. At most 20 webhooks per channel.</p>

      <details className="wh-help">
        <summary>How to send a message</summary>
        <p>Send a POST request to the address. Any of these work:</p>
        <pre className="wh-pre">{curlExample(PLACEHOLDER_URL)}</pre>
        <ul className="wh-points">
          <li>Plain text: send the text as the body and the message is posted as it is.</li>
          <li>JSON with <span className="wh-mono">text</span>, and optionally <span className="wh-mono">title</span>, <span className="wh-mono">url</span>, <span className="wh-mono">status</span> (success, failed, warning), <span className="wh-mono">fields</span> (a list of name and value pairs).</li>
          <li>The Slack and Mattermost shape (<span className="wh-mono">text</span> and <span className="wh-mono">attachments</span>) and alerts from Alertmanager or Sentry are understood too.</li>
          <li>
            GitHub: in the repository&rsquo;s Settings, Webhooks, choose &ldquo;Add webhook&rdquo;, paste the address as the Payload URL, set the content type to
            <span className="wh-mono"> application/json</span>, and pick the events you want. Pushes, pull requests, issues, workflow runs and releases are shown nicely; other events are skipped.
          </li>
          <li>Messages up to 1 MB are accepted, and one webhook takes 120 calls a minute.</li>
        </ul>
      </details>
    </Dialog>
  );
}

/** The button in a channel's header that opens the dialog; a lead or a workspace admin sees it. */
export function WebhooksButton({ channelId, channelName }: { channelId: string; channelName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn quiet wh-open" onClick={() => setOpen(true)} data-testid="webhooks-open" aria-haspopup="dialog" aria-label="Webhooks" title="Webhooks">
        <span className="wh-open-icon"><HookIcon /></span>
        <span className="wh-open-label">Webhooks</span>
      </button>
      {open ? <WebhooksDialog channelId={channelId} channelName={channelName} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
