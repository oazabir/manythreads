import { useRef, useState, type ChangeEvent } from 'react';
import type { BotRunner } from '@manythreads/shared';
import { isApiError } from '../../../api/client';
import { useQuery } from '../../../app/useQuery';
import { Dialog } from '../../../components/Dialog';
import { checkClaudeSignin, fetchClaudeUsage, removeClaudeCredentials, uploadClaudeCredentials, uploadCodexCredentials } from './api';
import { SIGNIN_WORDS, isSigninKind, othersSentence, previewSignin, signedInWords, uploadProblem, usageLines, type SigninPreview } from './commands';
import { SkeletonRows } from '../../../components/Skeleton';

/*
 * The sign-in of one Claude Code or Codex runner (PLAN P19-06, P19-13). The admin chooses the `.credentials.json` of a Claude login or the `auth.json` of a Codex
 * login with a ChatGPT account. The browser reads it only to show a summary (the plan, when the access part runs out, how many other entries the file holds) with
 * the shared reader, and sends the text unchanged. Nothing of the file is kept on this page after it goes up or is dropped, and a token is never shown. The server
 * keeps the file in the pod's own Secret. For Codex the plan name is read here from the file's tokens and sent in a header; the server reads no token.
 */

const message = (e: unknown): string => (isApiError(e) ? e.message : e instanceof Error ? e.message : 'Something went wrong. Try again.');

type Props = { runner: BotRunner; onClose: () => void; onChanged: (r: BotRunner, text: string) => void };

export function CredentialsDialog({ runner, onClose, onChanged }: Props) {
  const kind = isSigninKind(runner.kind) ? runner.kind : 'claude_cli';
  const words = SIGNIN_WORDS[kind];
  const [text, setText] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<SigninPreview | null>(null);
  const [terms, setTerms] = useState(false);
  const [others, setOthers] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const sending = useRef(false);
  const usage = useQuery(`runner-usage-${runner.id}`, fetchClaudeUsage);
  const signedIn = signedInWords(runner);
  const problem = uploadProblem(preview, { termsTicked: terms, signinsTicked: others }, kind);
  const lines = usage.status === 'ok' ? usageLines(usage.data.items, runner.id) : [];

  async function choose(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    setError(null);
    setResult(null);
    if (!file) {
      setText(null);
      setPreview(null);
      setFileName('');
      return;
    }
    // A real sign-in file is a few KB; a big one is refused here before it is read, with the server's own sentence.
    if (file.size > 256 * 1024) {
      setText(null);
      setFileName(file.name);
      setPreview({ ok: false, message: `That file is too large to be a ${words.program === 'Codex' ? 'Codex' : 'Claude'} sign-in file.` });
      return;
    }
    const body = await file.text();
    setFileName(file.name);
    setText(body);
    setPreview(previewSignin(body, kind));
    setTerms(false);
    setOthers(false);
  }

  async function run(work: () => Promise<{ runner: BotRunner; text: string }>): Promise<void> {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      const done = await work();
      setText(null);
      setPreview(null);
      setFileName('');
      setTerms(false);
      setOthers(false);
      setConfirmRemove(false);
      onChanged(done.runner, done.text);
    } catch (err) {
      setError(message(err));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  const upload = () =>
    run(async () => {
      if (text === null) throw new Error('Choose the sign-in file first.');
      if (kind === 'codex_cli' && preview?.ok !== true) throw new Error('Choose the sign-in file first.');
      const res = kind === 'codex_cli' && preview?.ok === true ? await uploadCodexCredentials(runner.id, text, preview.plan) : await uploadClaudeCredentials(runner.id, text);
      return { runner: res.runner, text: res.replaced ? `The sign-in of ${runner.label} was replaced. The runner is starting again.` : `${runner.label} is signed in and starting.` };
    });
  const remove = () => run(async () => ({ runner: (await removeClaudeCredentials(runner.id)).runner, text: `The sign-in of ${runner.label} was removed. It waits for a new one.` }));

  async function check(): Promise<void> {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await checkClaudeSignin(runner.id);
      setResult(res.message);
      onChanged(res.runner, res.message);
    } catch (err) {
      setError(message(err));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Sign-in for ${runner.label}`}
      onClose={onClose}
      wide
      testId="runner-signin-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Close</button>
          <button type="button" className="btn primary" onClick={() => void upload()} disabled={busy || problem !== null} data-testid="runner-signin-upload">
            {runner.uploadedAt ? 'Replace the sign-in' : 'Upload the sign-in'}
          </button>
        </>
      }
    >
      <div className="rn-form">
        {runner.status === 'needs_sign_in' ? (
          <p className="notice warn" role="status" data-testid="runner-signin-banner">
            {words.refused} {runner.statusDetail ?? 'Log in again and upload a new file.'}
          </p>
        ) : null}
        {signedIn ? <p className="dlg-text" data-testid="runner-signin-current">{signedIn}</p> : <p className="dlg-text" data-testid="runner-signin-none">No sign-in yet. Every {words.program === 'Codex' ? 'Codex' : 'Claude'} runner needs its own {words.login}.</p>}
        <div className="fld">
          <label htmlFor="runner-signin-file">Sign-in file ({words.fileName})</label>
          <input id="runner-signin-file" type="file" accept=".json,application/json" onChange={(e) => void choose(e)} disabled={busy} data-testid="runner-signin-file" data-autofocus="" />
          <div className="fld-hint">{kind === 'codex_cli' ? 'Log in with Codex on a computer of your own, using a ChatGPT account, then choose the auth.json it saved. ' : 'Log in with Claude Code on a computer of your own, then choose the file it saved. '}The file stays in this runner's pod. This page never shows it.</div>
        </div>
        {preview ? (
          preview.ok ? (
            <div className="dlg-text" data-testid="runner-signin-preview">
              <p><strong>{fileName}</strong>: {preview.plan}.</p>
              <p>{preview.expiresWords}</p>
              <p>{othersSentence(preview.others, kind)}</p>
            </div>
          ) : (
            <p className="dlg-error" role="alert" data-testid="runner-signin-invalid">{preview.message}</p>
          )
        ) : null}
        {preview?.ok ? (
          <>
            <label className="check">
              <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} data-testid="runner-signin-terms" /> {words.termsLabel}
            </label>
            {preview.needsAck ? (
              <label className="check">
                <input type="checkbox" checked={others} onChange={(e) => setOthers(e.target.checked)} data-testid="runner-signin-others" /> {kind === 'codex_cli' ? 'The other entries in the file may be stored with it, as they are.' : 'The other sign-ins in the file may be stored with it, as they are.'}
              </label>
            ) : null}
          </>
        ) : null}
        {problem && preview?.ok ? <p className="fld-hint rn-warn" data-testid="runner-signin-hint">{problem}</p> : null}
        {error ? <p className="dlg-error" role="alert" data-testid="runner-form-error">{error}</p> : null}
        {result ? <p className="dlg-text" role="status" data-testid="runner-signin-result">{result}</p> : null}

        {runner.uploadedAt ? (
          <div className="rn-actions">
            <button type="button" className="btn sm" onClick={() => void check()} disabled={busy} data-testid="runner-signin-check">Check the sign-in</button>
            {confirmRemove ? (
              <>
                <span className="dlg-text">Remove the sign-in? The runner stops until a new file is uploaded.</span>
                <button type="button" className="btn sm danger" onClick={() => void remove()} disabled={busy} data-testid="runner-signin-remove-yes">Remove it</button>
                <button type="button" className="btn sm" onClick={() => setConfirmRemove(false)} disabled={busy}>Keep it</button>
              </>
            ) : (
              <button type="button" className="btn sm" onClick={() => setConfirmRemove(true)} disabled={busy} data-testid="runner-signin-remove">Remove the sign-in</button>
            )}
          </div>
        ) : null}

        <h3 className="rn-sub">Use by team</h3>
        {usage.status === 'loading' ? (
          <SkeletonRows rows={2} label="Loading use by team" />
        ) : usage.status === 'error' ? (
          <p className="dlg-error" role="alert">{usage.error.message}</p>
        ) : lines.length === 0 ? (
          <p className="faint" data-testid="runner-usage-none">No bot has run here yet.</p>
        ) : (
          <table className="rn-usage" data-testid="runner-usage">
            <thead>
              <tr><th scope="col">Team</th><th scope="col">Runs</th><th scope="col">Minutes</th><th scope="col">{words.usageHeader}</th></tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.team}><th scope="row">{l.team}</th><td>{l.runs}</td><td>{l.minutes}</td><td>{l.cost ?? 'none'}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Dialog>
  );
}
