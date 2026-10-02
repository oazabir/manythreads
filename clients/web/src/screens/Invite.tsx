import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import type { AcceptInvitationResponse } from '@manythreads/shared';
import { isApiError } from '../api/client';
import { acceptInvitation, fetchInvitation, requestPasswordReset } from '../api/endpoints';
import { useQuery } from '../app/useQuery';
import { AuthFrame } from '../components/frames';
import { ExpiredLinkPage, FullPageMessage } from '../components/states';
import { Alert, Field, Notice } from '../components/ui';

/** Accept an invitation. A new person then sets a password through the reset link; an existing one just signs in. */
export function Invite() {
  const { token = '' } = useParams();
  const q = useQuery(`invite:${token}`, () => fetchInvitation(token));
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<AcceptInvitationResponse | null>(null);
  const [resetSent, setResetSent] = useState(false);
  const [gone, setGone] = useState(false);

  if (gone) return <ExpiredLinkPage kind="invitation" />;
  if (q.status === 'loading') return <FullPageMessage title="Loading" busy />;
  if (q.status === 'error') {
    if (isApiError(q.error) && (q.error.status === 410 || q.error.status === 404)) return <ExpiredLinkPage kind="invitation" />;
    return <FullPageMessage title="Cannot check this invitation" tone="alert" detail={q.error.message}><button type="button" className="btn" onClick={q.reload}>Try again</button></FullPageMessage>;
  }
  const inv = q.data;

  async function sendReset(email: string) {
    try {
      await requestPasswordReset(email);
      setResetSent(true);
    } catch (err) {
      setError(isApiError(err) ? err.message : 'Something went wrong. Try again.');
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await acceptInvitation(token, name.trim() === '' ? {} : { name });
      setDone(res);
      if (res.createdPerson) await sendReset(res.email);
    } catch (err) {
      if (isApiError(err) && (err.status === 410 || err.status === 404)) setGone(true);
      else setError(isApiError(err) ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <AuthFrame title={`You joined ${inv.workspaceName}`} lede={inv.teamName ? `You are on the ${inv.teamName} team.` : undefined}>
        {done.createdPerson ? (
          <>
            <p className="auth-lede">Set a password to finish. We sent a link to <b>{done.email}</b>.</p>
            {resetSent ? <Notice>Check your inbox for the set-password link.</Notice> : null}
            <div className="form-actions">
              <button type="button" className="btn" onClick={() => void sendReset(done.email)}>Send the link again</button>
            </div>
          </>
        ) : (
          <p className="auth-lede">Sign in with your existing account to get started.</p>
        )}
        {error ? <Alert>{error}</Alert> : null}
        <div className="auth-actions">
          <Link className="btn primary" to="/sign-in">Go to sign in</Link>
        </div>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame
      title={`Join ${inv.workspaceName}`}
      lede={`${inv.invitedBy ?? 'A workspace admin'} invited you${inv.teamName ? ` to the ${inv.teamName} team` : ''}.`}
      footer="This invitation works once."
    >
      <form onSubmit={onSubmit} noValidate>
        <Field label="Email" type="email" value={inv.email} readOnly />
        <Field label="Your name" name="name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" hint="Leave blank if you already have an account." />
        {error ? <Alert>{error}</Alert> : null}
        <div className="form-actions">
          <button type="submit" className="btn primary" disabled={busy}>Accept invitation</button>
        </div>
      </form>
    </AuthFrame>
  );
}
