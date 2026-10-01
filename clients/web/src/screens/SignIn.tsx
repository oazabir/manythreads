import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { isApiError } from '../api/client';
import { fetchSignInOptions, requestPasswordReset, signInWithPassword } from '../api/endpoints';
import { oidcStartPath, type SignInOptions } from '../api/schemas';
import { safeReturnPath } from '../app/paths';
import { useSessionState } from '../app/session';
import { useQuery } from '../app/useQuery';
import { AuthFrame } from '../components/frames';
import { Alert, Field, Notice } from '../components/ui';

const FALLBACK: SignInOptions = { workspaceName: null, google: false, microsoft: false, oidc: null, password: true };

export function SignIn() {
  const [params] = useSearchParams();
  const returnPath = safeReturnPath(params.get('return')) ?? '/';
  const { state, setSession } = useSessionState();
  const navigate = useNavigate();
  const options = useQuery('sign-in-options', fetchSignInOptions);
  const [mode, setMode] = useState<'sign-in' | 'forgot'>('sign-in');
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  if (state.status === 'ready') return <Navigate to={returnPath} replace />;

  // if the options cannot be loaded, still offer the password form
  const o = options.status === 'ok' ? options.data : FALLBACK;
  const passwordVisible = o.password || showPassword;
  const hasProviders = o.google || o.microsoft || o.oidc !== null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'forgot') {
        await requestPasswordReset(email);
        setResetSent(true);
      } else {
        const session = await signInWithPassword({ email, password });
        setSession(session);
        navigate(returnPath, { replace: true });
      }
    } catch (err) {
      setError(isApiError(err) ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame title={mode === 'forgot' ? 'Reset your password' : 'Sign in'} lede={o.workspaceName ?? undefined}>
      {options.status === 'loading' ? <p className="loading" aria-busy="true">Loading…</p> : null}
      {options.status !== 'loading' && mode === 'sign-in' && hasProviders ? (
        <div className="providers">
          {o.google ? (
            <a className="btn provider" href={oidcStartPath('google', returnPath)}>
              <span className="pmark g" aria-hidden="true">G</span>Continue with Google
            </a>
          ) : null}
          {o.microsoft ? (
            <a className="btn provider" href={oidcStartPath('microsoft', returnPath)}>
              <span className="pmark ms" aria-hidden="true">MS</span>Continue with Microsoft
            </a>
          ) : null}
          {o.oidc ? (
            <a className="btn provider" href={oidcStartPath('oidc', returnPath)}>
              <span className="pmark" aria-hidden="true">ID</span>Continue with {o.oidc.name}
            </a>
          ) : null}
        </div>
      ) : null}
      {mode === 'sign-in' && hasProviders && passwordVisible ? <div className="or" role="separator"><span>or</span></div> : null}
      {options.status !== 'loading' && !passwordVisible ? (
        <p className="auth-foot">
          Your workspace uses single sign-on. Admins can still{' '}
          <button type="button" className="linkish" onClick={() => setShowPassword(true)}>sign in with a password</button>.
        </p>
      ) : null}
      {options.status !== 'loading' && passwordVisible ? (
        <form onSubmit={onSubmit} noValidate>
          <Field label="Email" type="email" name="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
          {mode === 'sign-in' ? (
            <Field label="Password" type="password" name="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          ) : null}
          {resetSent ? <Notice>If that address has an account, a reset link is on its way.</Notice> : null}
          <div className="form-actions">
            <button type="submit" className="btn primary" disabled={busy}>{mode === 'forgot' ? 'Send reset link' : 'Sign in'}</button>
            {mode === 'sign-in' ? (
              <button type="button" className="linkish" onClick={() => { setMode('forgot'); setError(null); }}>Forgot password?</button>
            ) : (
              <button type="button" className="linkish" onClick={() => { setMode('sign-in'); setResetSent(false); setError(null); }}>Back to sign in</button>
            )}
          </div>
        </form>
      ) : null}
      {error ? <Alert>{error}</Alert> : null}
    </AuthFrame>
  );
}
