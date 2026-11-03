import { useRef, useState, type FormEvent } from 'react';
import { connectionKindInfo, type Connection, type ConnectionEnvironment, type ConnectionKindInfo } from '@manythreads/shared';
import { Dialog } from '../../components/Dialog';
import { Field } from '../../components/ui';
import { ConnectorGallery } from './ConnectorGallery';
import { createConnection, deleteConnection, putConnectionCredential, updateConnection } from './api';
import { ENVIRONMENTS, checkNew, expiryDate, expiryIso, kindLabel, message, suggestSlug, type NewErrors } from './words';

/*
 * The dialogs of the Connections pages. Each is a modal (`Dialog`): focus moves into it, Tab stays inside, Esc closes it and focus goes back to the button that
 * opened it. A failed action keeps the dialog open and says why in a sentence under the form. A credential is typed once: it is cleared from the field after a
 * failed send, never kept on the page after a good one, and never shown again by anything.
 */

function FormError({ text }: { text: string | null }) {
  return text ? <p className="dlg-error" role="alert" data-testid="connection-form-error">{text}</p> : null;
}

function EnvironmentSelect({ id, value, onChange }: { id: string; value: ConnectionEnvironment; onChange: (v: ConnectionEnvironment) => void }) {
  return (
    <div className="fld">
      <label htmlFor={id}>What it touches</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as ConnectionEnvironment)} data-testid="connection-environment">
        {ENVIRONMENTS.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
      </select>
      <div className="fld-hint">A tag, so a test mailbox is never mistaken for the real one. It changes nothing by itself.</div>
    </div>
  );
}

// ---- add -------------------------------------------------------------------------------------------------------

/** What happened when the connection was added: all of it, or the connection exists but a later step failed (and `problem` says which). */
export type AddResult = { connection: Connection; on: boolean; problem: string | null };

type AddProps = { teamSlug: string; onClose: () => void; onDone: (r: AddResult) => void };

export function AddConnectionDialog({ teamSlug, onClose, onDone }: AddProps) {
  const [kind, setKind] = useState<ConnectionKindInfo | null>(null);
  return kind === null ? <Chooser onClose={onClose} onPick={setKind} /> : <AddForm kind={kind} teamSlug={teamSlug} onBack={() => setKind(null)} onClose={onClose} onDone={onDone} />;
}

function Chooser({ onClose, onPick }: { onClose: () => void; onPick: (k: ConnectionKindInfo) => void }) {
  return (
    <Dialog title="Add a connection" onClose={onClose} wide testId="connection-add-chooser" footer={<button type="button" className="btn" onClick={onClose}>Cancel</button>}>
      <ConnectorGallery onPick={onPick} onNavigate={onClose} />
    </Dialog>
  );
}

function AddForm({ kind, teamSlug, onBack, onClose, onDone }: AddProps & { kind: ConnectionKindInfo; onBack: () => void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [environment, setEnvironment] = useState<ConnectionEnvironment>('production');
  const [expires, setExpires] = useState('');
  const [credential, setCredential] = useState('');
  const [switchOn, setSwitchOn] = useState(true);
  const [errors, setErrors] = useState<NewErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // a ref, not the state: two quick presses (or Enter twice) can both pass before the first re-render sets `busy`
  const sending = useRef(false);
  const cred = kind.credentials[0];

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (sending.current) return;
    setError(null);
    const found = checkNew({ name, slug, credential }, expires);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const when = expiryIso(expires);
    sending.current = true;
    setBusy(true);
    let made: Connection;
    try {
      made = (
        await createConnection(teamSlug, {
          kind: kind.kind,
          name: name.trim(),
          ...(slug.trim() === '' ? {} : { slug: slug.trim() }),
          environment,
          ...(when === null || when === 'invalid' ? {} : { expiresAt: when }),
        })
      ).connection;
    } catch (err) {
      setError(message(err));
      setCredential('');
      sending.current = false;
      setBusy(false);
      return;
    }
    // The connection exists from here on. The credential and the switch are separate calls (the credential is sealed in its own step), so a failure now closes this
    // dialog and the page says what is still to do; "Change" finishes it.
    let current = made;
    let problem: string | null = null;
    try {
      if (credential !== '' && cred) current = (await putConnectionCredential(made.id, cred.name, credential)).connection;
    } catch (err) {
      problem = `The credential was not saved: ${message(err)}`;
    }
    setCredential('');
    if (problem === null && credential !== '' && switchOn) {
      try {
        current = (await updateConnection(made.id, { status: 'enabled' })).connection;
      } catch (err) {
        problem = `It could not be switched on: ${message(err)}`;
      }
    }
    onDone({ connection: current, on: current.status === 'enabled', problem });
  }

  return (
    <Dialog
      title={`Add a connection: ${kind.label}`}
      onClose={onClose}
      wide
      testId="connection-add-form"
      footer={
        <>
          <button type="button" className="btn" onClick={onBack} disabled={busy}>Back</button>
          <button type="submit" form="connection-add" className="btn primary" disabled={busy} data-testid="connection-add-submit">Add connection</button>
        </>
      }
    >
      <form id="connection-add" className="cn-form" onSubmit={(e) => void submit(e)} noValidate autoComplete="off">
        <Field
          label="Name"
          data-autofocus=""
          value={name}
          maxLength={80}
          placeholder="Support mailbox"
          hint="What people read when they see this connection."
          error={errors.name}
          onChange={(e) => {
            setName(e.target.value);
            if (!slugTouched) setSlug(suggestSlug(e.target.value));
          }}
        />
        <Field
          label="Short name"
          value={slug}
          maxLength={63}
          className="mono"
          hint="A bot’s definition uses this name to say which connection it works through. It cannot be changed later. Left empty, it is made from the name."
          error={errors.slug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value);
          }}
        />
        <EnvironmentSelect id="connection-add-environment" value={environment} onChange={setEnvironment} />
        <Field
          label="Stops working on (optional)"
          type="date"
          value={expires}
          hint="The day its credential runs out, if you know it. After that day the connection offers no tools until the credential is renewed."
          error={errors.expires}
          onChange={(e) => setExpires(e.target.value)}
        />
        {cred ? (
          <Field
            label={cred.label}
            type="password"
            autoComplete="new-password"
            value={credential}
            hint={`${cred.hint} You can also add it later with Change.`}
            data-testid="connection-credential"
            onChange={(e) => setCredential(e.target.value)}
          />
        ) : null}
        {cred ? (
          <label className="check cn-check">
            <input type="checkbox" checked={switchOn} onChange={(e) => setSwitchOn(e.target.checked)} data-testid="connection-switch-on" />
            <span>Switch it on once the credential is saved</span>
          </label>
        ) : null}
        <FormError text={error} />
      </form>
    </Dialog>
  );
}

// ---- change ----------------------------------------------------------------------------------------------------

export function ChangeConnectionDialog({ connection, onClose, onDone }: { connection: Connection; onClose: () => void; onDone: (c: Connection, note: string) => void }) {
  const info = connectionKindInfo(connection.kind);
  const cred = info?.credentials[0];
  const [name, setName] = useState(connection.name);
  const [environment, setEnvironment] = useState<ConnectionEnvironment>(connection.environment);
  const [expires, setExpires] = useState(expiryDate(connection.expiresAt));
  const [credential, setCredential] = useState('');
  const [errors, setErrors] = useState<NewErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);

  const when = expiryIso(expires);
  const nameChanged = name.trim() !== connection.name;
  const envChanged = environment !== connection.environment;
  const expiryChanged = when !== 'invalid' && when !== (connection.expiresAt === null ? null : connection.expiresAt);
  // the expiry is stored as the end of a day: choosing the same day again is not a change
  const sameDay = connection.expiresAt !== null && expires === expiryDate(connection.expiresAt);
  const dirty = nameChanged || envChanged || (expiryChanged && !sameDay) || credential !== '';

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (sending.current) return;
    setError(null);
    const found = checkNew({ name, slug: '', credential }, expires);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    if (!dirty) return onClose();
    sending.current = true;
    setBusy(true);
    try {
      let current = connection;
      const patch = {
        ...(nameChanged ? { name: name.trim() } : {}),
        ...(envChanged ? { environment } : {}),
        ...(expiryChanged && !sameDay && when !== 'invalid' ? { expiresAt: when } : {}),
      };
      if (Object.keys(patch).length > 0) current = (await updateConnection(connection.id, patch)).connection;
      if (credential !== '' && cred) current = (await putConnectionCredential(connection.id, cred.name, credential)).connection;
      setCredential('');
      onDone(current, credential !== '' ? `${current.name} was saved and its credential was replaced.` : `${current.name} was saved.`);
    } catch (err) {
      setError(message(err));
      setCredential('');
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Change ${connection.name}`}
      onClose={onClose}
      wide
      testId="connection-change-form"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" form="connection-change" className="btn primary" disabled={busy} data-testid="connection-change-submit">Save</button>
        </>
      }
    >
      <form id="connection-change" className="cn-form" onSubmit={(e) => void submit(e)} noValidate autoComplete="off">
        <p className="dlg-text">
          {kindLabel(connection.kind)} · short name <code>{connection.slug}</code>. The kind and the short name cannot be changed. To use another, add a new connection.
        </p>
        <Field label="Name" data-autofocus="" value={name} maxLength={80} error={errors.name} onChange={(e) => setName(e.target.value)} />
        <EnvironmentSelect id="connection-change-environment" value={environment} onChange={setEnvironment} />
        <Field label="Stops working on (optional)" type="date" value={expires} error={errors.expires} hint="Empty means no end date." onChange={(e) => setExpires(e.target.value)} />
        {cred ? (
          <Field
            label={connection.hasCredentials ? `New ${cred.label.toLowerCase()}` : cred.label}
            type="password"
            autoComplete="new-password"
            value={credential}
            hint={connection.hasCredentials ? 'A credential is stored and cannot be shown. Type a new one only to replace it; leave this empty to keep the stored one.' : cred.hint}
            data-testid="connection-credential"
            onChange={(e) => setCredential(e.target.value)}
          />
        ) : null}
        <FormError text={error} />
      </form>
    </Dialog>
  );
}

// ---- remove ----------------------------------------------------------------------------------------------------

export function RemoveConnectionDialog({ connection, mine, onClose, onDone }: { connection: Connection; mine?: boolean; onClose: () => void; onDone: (c: Connection) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function remove(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await deleteConnection(connection.id);
      onDone(connection);
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Remove ${connection.name}?`}
      onClose={onClose}
      testId="connection-remove-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>{error ? 'Close' : 'Cancel'}</button>
          <button type="button" className="btn danger" onClick={() => void remove()} disabled={busy} data-testid="connection-remove-confirm">Remove connection</button>
        </>
      }
    >
      <p className="dlg-text">
        {mine
          ? 'This removes the connection and the credential stored with it. A bot can no longer work through it for you. It cannot be undone.'
          : 'This removes the connection and the credential stored with it. Bots of the team lose the tools they had through it. It cannot be undone.'}
      </p>
      <FormError text={error} />
    </Dialog>
  );
}
