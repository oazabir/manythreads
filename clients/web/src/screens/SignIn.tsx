import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { OIDC_SIGN_IN_ERROR_MESSAGES, OidcSignInErrorCode, type OidcProviderKind } from '@manythreads/shared';
import { isApiError } from '../api/client';
import { fetchOidcMethods, fetchSession, oidcStartUrl, requestPasswordReset, signInWithPassword } from '../api/endpoints';
import { safeReturnPath } from '../app/paths';
import { useSessionState } from '../app/session';
import { useQuery } from '../app/useQuery';
import { AuthFrame } from '../components/frames';
import { Alert, Field, Notice } from '../components/ui';

const MARKS: Record<OidcProviderKind, { text: string; cls: string }> = {
  google: { text: 'G', cls: 'g' },
  microsoft: { text: 'MS', cls: 'ms' },
  oidc: { text: 'ID', cls: '' },
};

/** The sentence for `/sign-in?error=<code>` (an OIDC refusal), or null. */
export function oidcErrorMessage(code: string | null): string | null {
  const parsed = OidcSignInErrorCode.safeParse(code);
  return parsed.success ? OIDC_SIGN_IN_ERROR_MESSAGES[parsed.data] : null;
}

export function SignIn() {
  const [params] = useSearchParams();
  const returnPath = safeReturnPath(params.get('return')) ?? '/';
  const { state, setSession } = useSessionState();
  const navigate = useNavigate();
  const discovery = useQuery('sign-in-discovery', fetchSession);
  const oidc = useQuery('sign-in-oidc', () => fetchOidcMethods().catch(() => ({ methods: [] })));
  const [mode, setMode] = useState<'sign-in' | 'forgot'>('sign-in');
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(oidcErrorMessage(params.get('error')));
  const [busy, setBusy] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  if (state.status === 'ready') return <Navigate to={returnPath} replace />;

  const loading = discovery.status === 'loading' || oidc.status === 'loading';
  // if discovery cannot be loaded, still offer the password form
  const passwordOn = discovery.status === 'ok' ? discovery.data.methods.some((m) => m.kind === 'password') : true;
  const providers = oidc.status === 'ok' ? oidc.data.methods : [];
  const passwordVisible = passwordOn || showPassword;
  const hasProviders = providers.length > 0;

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
    <AuthFrame title={mode === 'forgot' ? 'Reset your password' : 'Sign in'}>
      {loading ? <p className="loading" aria-busy="true">Loading…</p> : null}
      {!loading && mode === 'sign-in' && hasProviders ? (
        <div className="providers">
          {providers.map((p) => (
            <a key={p.id} className="btn provider" href={oidcStartUrl(p.startUrl, returnPath)}>
              <span className={`pmark ${MARKS[p.kind].cls}`} aria-hidden="true">{MARKS[p.kind].text}</span>Continue with {p.label}
            </a>
          ))}
        </div>
      ) : null}
      {!loading && mode === 'sign-in' && hasProviders && passwordVisible ? <div className="or" role="separator"><span>or</span></div> : null}
      {!loading && !passwordVisible ? (
        <p className="auth-foot">
          Your workspace uses single sign-on. Admins can still{' '}
          <button type="button" className="linkish" onClick={() => setShowPassword(true)}>sign in with a password</button>.
        </p>
      ) : null}
      {!loading && passwordVisible ? (
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
