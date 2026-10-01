import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { isApiError } from '../api/client';
import { acceptInvitation, fetchInvitation } from '../api/endpoints';
import { useSessionState } from '../app/session';
import { useQuery } from '../app/useQuery';
import { AuthFrame } from '../components/frames';
import { ExpiredLinkPage, FullPageMessage } from '../components/states';
import { Alert, Field, PasswordField } from '../components/ui';

export function Invite() {
  const { token = '' } = useParams();
  const q = useQuery(`invite:${token}`, () => fetchInvitation(token));
  const { setSession } = useSessionState();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (q.status === 'loading') return <FullPageMessage title="Loading" busy />;
  if (q.status === 'error') {
    if (isApiError(q.error) && (q.error.status === 410 || q.error.status === 404)) return <ExpiredLinkPage kind="invitation" />;
    return <FullPageMessage title="Cannot check this invitation" tone="alert" detail={q.error.message}><button type="button" className="btn" onClick={q.reload}>Try again</button></FullPageMessage>;
  }
  const inv = q.data;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      setSession(await acceptInvitation(token, { name, password }));
      navigate('/', { replace: true });
    } catch (err) {
      if (isApiError(err) && (err.status === 410 || err.status === 404)) navigate('/expired?kind=invitation', { replace: true });
      else setError(isApiError(err) ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame
      title={`Join ${inv.workspaceName}`}
      lede={`${inv.invitedBy} invited you${inv.teamName ? ` to the ${inv.teamName} team` : ''}.`}
      footer="This invitation works once."
    >
      <form onSubmit={onSubmit} noValidate>
        <Field label="Email" type="email" value={inv.email} readOnly />
        <Field label="Name" name="name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        <PasswordField value={password} onChange={setPassword} />
        {error ? <Alert>{error}</Alert> : null}
        <div className="form-actions">
          <button type="submit" className="btn primary" disabled={busy}>Accept invitation</button>
        </div>
      </form>
    </AuthFrame>
  );
}
