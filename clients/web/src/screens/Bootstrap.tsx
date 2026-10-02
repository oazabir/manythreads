import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { isApiError } from '../api/client';
import { bootstrapWorkspace, checkBootstrapToken } from '../api/endpoints';
import { useSessionState } from '../app/session';
import { useQuery } from '../app/useQuery';
import { AuthFrame } from '../components/frames';
import { ExpiredLinkPage, FullPageMessage } from '../components/states';
import { Alert, Field, PasswordField } from '../components/ui';

/** Step 0: the one-time bootstrap URL creates the workspace and its first admin. */
export function Bootstrap() {
  const { token = '' } = useParams();
  const check = useQuery(`bootstrap:${token}`, () => checkBootstrapToken(token));
  const { setSession } = useSessionState();
  const navigate = useNavigate();
  const [workspaceName, setWorkspaceName] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (check.status === 'loading') return <FullPageMessage title="Loading" busy />;
  if (check.status === 'error') {
    if (isApiError(check.error) && (check.error.status === 410 || check.error.status === 404)) return <ExpiredLinkPage kind="bootstrap" />;
    return <FullPageMessage title="Cannot check this link" tone="alert" detail={check.error.message}><button type="button" className="btn" onClick={check.reload}>Try again</button></FullPageMessage>;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const session = await bootstrapWorkspace(token, { workspaceName, name, email, password });
      setSession(session);
      navigate('/', { replace: true });
    } catch (err) {
      if (isApiError(err) && (err.status === 410 || err.status === 404)) navigate('/expired?kind=bootstrap', { replace: true });
      else setError(isApiError(err) ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame title="Set up your workspace" footer="This link works once.">
      <form onSubmit={onSubmit} noValidate data-landmark="form">
        <Field label="Workspace" name="workspace" value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} placeholder="Kahf Software" autoComplete="organization" />
        <Field label="Name" name="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" autoComplete="name" />
        <Field label="Email" type="email" name="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="username" />
        <PasswordField value={password} onChange={setPassword} />
        {error ? <Alert>{error}</Alert> : null}
        <div className="form-actions">
          <button type="submit" className="btn primary" disabled={busy}>Create workspace</button>
        </div>
      </form>
    </AuthFrame>
  );
}
