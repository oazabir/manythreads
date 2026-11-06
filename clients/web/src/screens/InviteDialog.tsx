import { useId, useState, type FormEvent } from 'react';
import { isApiError } from '../api/client';
import { createWorkspaceInvitation } from '../api/endpoints';
import { Dialog } from '../components/Dialog';
import { Alert, Field, Notice } from '../components/ui';

type Role = 'member' | 'admin';
const ROLE_HINT: Record<Role, string> = {
  member: 'Can join teams and read their channels.',
  admin: 'Can also change workspace settings and manage people.',
};

/**
 * Invite someone to the workspace by email (admins only). The one-time link is shown after sending, because mail may not be set up; it works once.
 * A guest needs channels chosen first, so guests are invited from a channel, not here.
 */
export function InviteDialog({ onClose }: { onClose: () => void }) {
  const roleId = useId();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ email: string; link: string } | null>(null);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await createWorkspaceInvitation({ email: email.trim(), role });
      setSent({ email: res.invitation.email, link: `${window.location.origin}/invite/${res.token}` });
    } catch (err) {
      setError(isApiError(err) ? err.message : 'Could not send the invitation. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <Dialog title="Invitation ready" onClose={onClose} testId="invite-dialog" footer={<button type="button" className="btn primary" onClick={onClose}>Done</button>}>
        <Notice>
          Invitation for {sent.email}: <a href={sent.link} className="mono" data-testid="invite-link">{sent.link}</a>
        </Notice>
        <p className="fld-hint">The link works once, and is also mailed when mail is set up.</p>
      </Dialog>
    );
  }
  return (
    <Dialog
      title="Invite people"
      onClose={onClose}
      testId="invite-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="invite-form" className="btn primary" disabled={busy || email.trim() === ''}>Send invitation</button>
        </>
      }
    >
      <form id="invite-form" onSubmit={(e) => void submit(e)} noValidate>
        <Field label="Email" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="nadia@kahf.co" data-testid="invite-email" />
        <div className="fld">
          <label htmlFor={roleId}>Role</label>
          <select id={roleId} value={role} onChange={(e) => setRole(e.target.value as Role)} data-testid="invite-role">
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
          <div className="fld-hint">{ROLE_HINT[role]}</div>
        </div>
        {error ? <Alert>{error}</Alert> : null}
      </form>
    </Dialog>
  );
}
