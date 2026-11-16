import { useState, type FormEvent } from 'react';
import { isApiError } from '../api/client';
import { changePassword, signOut } from '../api/endpoints';
import { useSessionState } from '../app/session';
import { AuthFrame } from '../components/frames';
import { Alert, PasswordField } from '../components/ui';

/**
 * Shown instead of the app while the password in use was made up for the person (the first one the installer printed, or one an operator generated):
 * a person who holds only that password cannot go on until they have chosen their own. It uses the same call as Account, Security.
 */
export function FirstPassword({ email }: { email: string }) {
  const { refresh, setSession } = useSessionState();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await changePassword({ currentPassword: current, newPassword: next });
      refresh();
    } catch (err) {
      setError(isApiError(err) ? err.message : 'Something went wrong. Try again.');
      setBusy(false);
    }
  }

  return (
    <AuthFrame
      title="Choose your own password"
      lede={`You signed in as ${email} with a password that was made up for you. Choose your own before you go on.`}
      footer="Other browsers signed in as you are signed out when you change it."
    >
      <form onSubmit={onSubmit} noValidate data-testid="first-password-form">
        <PasswordField label="The password you were given" value={current} onChange={setCurrent} autoComplete="current-password" />
        <PasswordField label="Your new password" value={next} onChange={setNext} />
        {error ? <Alert>{error}</Alert> : null}
        <div className="form-actions">
          <button type="submit" className="btn primary" disabled={busy || current === '' || next === ''}>Set my password</button>
          <button
            type="button"
            className="btn quiet"
            onClick={() => {
              void signOut().finally(() => setSession(null));
            }}
          >
            Sign out
          </button>
        </div>
      </form>
    </AuthFrame>
  );
}
