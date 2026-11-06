import { useState, type FormEvent } from 'react';
import { isApiError } from '../../api/client';
import { updateAccount } from '../../api/endpoints';
import { useSession, useSessionState } from '../../app/session';
import { MyAvatarPicker } from '../../avatars/MyAvatarPicker';
import { PageHeader } from '../../components/PageHeader';
import { Alert, Avatar, Field, Notice } from '../../components/ui';

/** Account → Profile: the name, picture, email and workspace role other people see. Password and sessions live on Security. */
export function Profile() {
  const session = useSession();
  const { setSession } = useSessionState();
  const [name, setName] = useState(session.person.name);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  async function saveName(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      const { person } = await updateAccount({ displayName: name });
      setSession({ ...session, person: { ...session.person, name: person.name } });
      setName(person.name);
      setNote('Name saved.');
    } catch (err) {
      setError(isApiError(err) ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Profile" description="How you appear to the people and bots in this workspace." />
      <section className="block" aria-labelledby="acc-profile" data-landmark="profile">
        <h2 className="bh" id="acc-profile">About you</h2>
        <div className="block-body">
          <form className="inline-form" onSubmit={saveName} noValidate>
            <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={120} />
            <button type="submit" className="btn primary" disabled={busy || name.trim() === '' || name.trim() === session.person.name}>Save name</button>
          </form>
          {error ? <Alert>{error}</Alert> : null}
          {note ? <Notice>{note}</Notice> : null}
          <div className="kv" data-testid="account-picture">
            <span className="k">Picture</span>
            <span className="acc-pic">
              <Avatar name={session.person.name} avatar={session.person.avatar} personId={session.person.id} />
              <button type="button" className="btn s" onClick={() => setPicking(true)} data-testid="account-change-picture">Change picture</button>
            </span>
          </div>
          <div className="kv"><span className="k">Email</span><span>{session.person.email}</span></div>
          <div className="kv"><span className="k">Workspace</span><span>{session.workspace.name} · {session.role}</span></div>
        </div>
      </section>
      {picking ? <MyAvatarPicker onClose={() => setPicking(false)} /> : null}
    </>
  );
}
