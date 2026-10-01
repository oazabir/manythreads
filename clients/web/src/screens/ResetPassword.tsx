import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { isApiError } from '../api/client';
import { resetPassword, verifyEmail } from '../api/endpoints';
import { useQuery } from '../app/useQuery';
import { AuthFrame } from '../components/frames';
import { ExpiredLinkPage, FullPageMessage } from '../components/states';
import { Alert, Notice, PasswordField } from '../components/ui';

/** `/reset-password/:token`: the link in the reset (and set-password) mail. */
export function ResetPassword() {
  const { token = '' } = useParams();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [gone, setGone] = useState(false);

  if (gone) return <ExpiredLinkPage kind="reset" />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await resetPassword(token, password);
      setDone(true);
    } catch (err) {
      if (isApiError(err) && err.status === 410) setGone(true);
      else setError(isApiError(err) ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame title="Choose a new password" footer="This link works once.">
      {done ? (
        <>
          <Notice>Password updated. Every other session was signed out.</Notice>
          <div className="auth-actions"><Link className="btn primary" to="/sign-in">Go to sign in</Link></div>
        </>
      ) : (
        <form onSubmit={onSubmit} noValidate>
          <PasswordField label="New password" value={password} onChange={setPassword} />
          {error ? <Alert>{error}</Alert> : null}
          <div className="form-actions"><button type="submit" className="btn primary" disabled={busy}>Set password</button></div>
        </form>
      )}
    </AuthFrame>
  );
}

/** `/verify-email/:token`: confirms the address as soon as the page opens. */
export function VerifyEmail() {
  const { token = '' } = useParams();
  const q = useQuery(`verify:${token}`, () => verifyEmail(token));
  if (q.status === 'loading') return <FullPageMessage title="Verifying your email" busy />;
  if (q.status === 'error') {
    if (isApiError(q.error) && q.error.status === 410) return <ExpiredLinkPage kind="reset" />;
    return <FullPageMessage title="Could not verify this link" tone="alert" detail={q.error.message} />;
  }
  return (
    <FullPageMessage title="Email verified" detail={q.data.email}>
      <Link className="btn primary" to="/">Continue to manythreads</Link>
    </FullPageMessage>
  );
}
