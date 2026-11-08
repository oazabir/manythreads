import { useState } from 'react';
import { Link } from 'react-router';
import type { ConnectorRoot, KnowledgeConnectorProvider, KnowledgeSource } from '@manythreads/shared';
import { useQuery } from '../../app/useQuery';
import { Dialog } from '../../components/Dialog';
import { Time } from '../../components/ui';
import { addPersonalConnectorSource, addTeamConnectorSource, fetchConnectorProviders, fetchConnectorRoots } from './api';

/*
 * Documents from a connected app (PLAN Bundle D, P16-08; docs/plugins/knowledge.md "Documents from connected apps"). A person picks one of the apps they have connected, then a folder,
 * space, site or database that connection can open. For a team base the lead is told in one sentence what will be copied: only what everyone on the team can already open at the app.
 * Nothing is copied before the sentence is confirmed. Plain words; no token, address or other person's name is ever shown here.
 */

const PROVIDER_NAME: Record<KnowledgeConnectorProvider, string> = {
  notion: 'Notion',
  confluence: 'Confluence',
  google_drive: 'Google Drive',
  sharepoint: 'SharePoint',
  onedrive: 'OneDrive',
  dropbox: 'Dropbox',
  box: 'Box',
};
export const providerName = (p: KnowledgeConnectorProvider | null | undefined): string => (p ? PROVIDER_NAME[p] : 'Connected app');

const RHYTHM_CHOICES: ReadonlyArray<{ minutes: number; label: string }> = [
  { minutes: 15, label: 'Every 15 minutes' },
  { minutes: 60, label: 'Every hour' },
  { minutes: 360, label: 'Every 6 hours' },
  { minutes: 1440, label: 'Every day' },
];

const KIND_WORD: Record<string, string> = { folder: 'Folder', space: 'Space', site: 'Site', drive: 'Drive', database: 'Database', workspace: 'Workspace' };
const rootLabel = (r: ConnectorRoot): string => `${r.parent ? `${r.parent} / ` : ''}${r.name} (${(KIND_WORD[r.kind] ?? r.kind).toLowerCase()})`;
const count = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;
/** True when a list of roots was asked for this app: `useQuery` keeps the last answer on screen while a new key loads, so another app's folders must not be offered under this app's name. */
export const rootsAreFor = (answer: { provider: KnowledgeConnectorProvider } | undefined, provider: KnowledgeConnectorProvider): boolean => answer !== undefined && answer.provider === provider;
const problem = (e: unknown): string => (e instanceof Error && e.message !== '' ? e.message : 'The source could not be added. Try again.');

/** The consent sentence a lead confirms before a team base reads a connected app. */
export const TEAM_RULE_SENTENCE = 'Documents everyone on this team can already open will be copied into this base. Others stay with the people who can open them.';

/** What a connector source says about itself in the Sources list: where it comes from, whose connection reads it, the last read, the counts, and why it stopped. */
export function ConnectorSourceLine({ source }: { source: KnowledgeSource }) {
  const status = source.status ?? 'ready';
  const left = source.skippedLimited ?? 0;
  return (
    <div className="kn-source" data-testid="connector-source" data-status={status}>
      <div className="kn-source-title">
        {providerName(source.provider)}: {source.label ?? source.remoteRoot ?? 'Connected folder'}
      </div>
      {source.readWith ? <div className="kn-source-sub">Read with {source.readWith}</div> : null}
      <div className={`kn-source-state ${status}`} data-testid="connector-source-state">
        {status === 'ready' ? (
          <>
            {source.lastSyncedAt ? <>Read <Time iso={source.lastSyncedAt} /></> : 'Not read yet'}
            {source.documentCount !== undefined ? ` · ${count(source.documentCount, 'document', 'documents')}` : ''}
          </>
        ) : status === 'paused' ? (
          <>
            Paused: {source.error ?? 'the sign-in is no longer connected.'} <Link to="/settings/connections">Connect it again</Link>
          </>
        ) : (
          <>Needs attention: {source.error ?? 'the last read did not work. It is tried again on its own.'}</>
        )}
      </div>
      {left > 0 ? (
        <div className="kn-source-sub" data-testid="connector-source-skipped">
          {count(left, 'document', 'documents')} not added: not everyone on the team can open {left === 1 ? 'it' : 'them'}.
        </div>
      ) : null}
    </div>
  );
}

type Where = { team: string } | { team: null };

/** The button and dialog that add a source to a team base (`team` is the team's address) or to a Personal base (`team: null`). */
export function ConnectorSourceForm({ team, base, disabled, onAdded }: Where & { base: string; disabled?: boolean; onAdded: (line: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn s" disabled={disabled} onClick={() => setOpen(true)} data-testid="connector-add">
        Add from a connected app
      </button>
      {open ? (
        <Dialog title="Add documents from a connected app" onClose={() => setOpen(false)} testId="connector-add-dialog">
          <AddBody
            team={team}
            base={base}
            onClose={() => setOpen(false)}
            onAdded={(line) => {
              setOpen(false);
              onAdded(line);
            }}
          />
        </Dialog>
      ) : null}
    </>
  );
}

function AddBody({ team, base, onClose, onAdded }: Where & { base: string; onClose: () => void; onAdded: (line: string) => void }) {
  const providers = useQuery('connector-providers', fetchConnectorProviders);
  if (providers.status === 'loading') return <p className="mi-help" aria-busy="true">Looking at your connected apps…</p>;
  if (providers.status === 'error') {
    return (
      <>
        <p className="kn-note bad" role="alert">Your connected apps could not be loaded: {providers.error.message}</p>
        <div className="kn-form-actions">
          <button type="button" className="btn s" onClick={providers.reload}>Try again</button>
          <button type="button" className="btn s" onClick={onClose}>Close</button>
        </div>
      </>
    );
  }
  if (providers.data.providers.length === 0) {
    return (
      <>
        <p className="mi-help" data-testid="connector-none">
          You have not connected an app that holds documents. Connect Google Drive, OneDrive, SharePoint, Notion, Confluence, Dropbox or Box in <Link to="/settings/connections">your connected accounts</Link>, then come back and add a folder.
        </p>
        <div className="kn-form-actions">
          <button type="button" className="btn s" onClick={onClose}>Close</button>
        </div>
      </>
    );
  }
  return <Picker team={team} base={base} providers={providers.data.providers} onClose={onClose} onAdded={onAdded} />;
}

function Picker({ team, base, providers, onClose, onAdded }: Where & { base: string; providers: KnowledgeConnectorProvider[]; onClose: () => void; onAdded: (line: string) => void }) {
  const [provider, setProvider] = useState<KnowledgeConnectorProvider>(providers[0] as KnowledgeConnectorProvider);
  const [root, setRoot] = useState('');
  const [minutes, setMinutes] = useState(60);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asked = useQuery(`connector-roots:${provider}`, () => fetchConnectorRoots({ provider }).then((r) => ({ ...r, provider })));
  const roots = asked.status === 'ok' && !rootsAreFor(asked.data, provider) ? { ...asked, status: 'loading' as const } : asked;
  const list = roots.status === 'ok' ? roots.data.roots : [];
  const chosen = list.find((r) => r.id === root) ?? null;
  const forTeam = team !== null;
  const ready = chosen !== null && (!forTeam || agreed) && !busy;

  const submit = (): void => {
    if (!chosen || !ready) return;
    setBusy(true);
    setError(null);
    const body = { provider, root: chosen.id, label: chosen.name.slice(0, 120), syncMinutes: minutes, acknowledgeTeamRule: forTeam && agreed };
    const made = team === null ? addPersonalConnectorSource(base, body) : addTeamConnectorSource(team, base, body);
    made.then(
      (res) => onAdded(`${res.source.label ?? chosen.name} was added. It is being read now, and its documents appear here in a minute.`),
      (e: unknown) => {
        setBusy(false);
        setError(problem(e));
      },
    );
  };

  return (
    <form
      className="kn-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      data-testid="connector-form"
    >
      <p className="mi-help">The documents are read with your own connection, so only what you can open can be added.</p>
      <label className="mi-label" htmlFor="kn-conn-provider">App</label>
      <select
        id="kn-conn-provider"
        className="mi-input"
        value={provider}
        onChange={(e) => {
          setProvider(e.target.value as KnowledgeConnectorProvider);
          setRoot('');
        }}
        data-testid="connector-provider"
      >
        {providers.map((p) => (
          <option key={p} value={p}>{providerName(p)}</option>
        ))}
      </select>

      <label className="mi-label" htmlFor="kn-conn-root">Folder, space or site</label>
      {roots.status === 'loading' ? <p className="mi-help" aria-busy="true">Loading what {providerName(provider)} offers…</p> : null}
      {roots.status === 'error' ? <p className="kn-note bad" role="alert">{providerName(provider)} did not answer: {roots.error.message} <button type="button" className="btn s" onClick={roots.reload}>Try again</button></p> : null}
      {roots.status === 'ok' && !roots.data.connected ? (
        <p className="mi-help" data-testid="connector-not-connected">{providerName(provider)} is not connected for you any more. <Link to="/settings/connections">Connect it again</Link>.</p>
      ) : null}
      {roots.status === 'ok' && roots.data.connected && list.length === 0 ? <p className="mi-help" data-testid="connector-no-roots">{providerName(provider)} has nothing here to add yet.</p> : null}
      {list.length > 0 ? (
        <select id="kn-conn-root" className="mi-input" value={root} onChange={(e) => setRoot(e.target.value)} data-testid="connector-root">
          <option value="">Choose one…</option>
          {list.map((r) => (
            <option key={r.id} value={r.id}>{rootLabel(r)}</option>
          ))}
        </select>
      ) : null}

      <label className="mi-label" htmlFor="kn-conn-rhythm">Read it again</label>
      <select id="kn-conn-rhythm" className="mi-input" value={String(minutes)} onChange={(e) => setMinutes(Number(e.target.value))} data-testid="connector-rhythm">
        {RHYTHM_CHOICES.map((r) => (
          <option key={r.minutes} value={String(r.minutes)}>{r.label}</option>
        ))}
      </select>

      {forTeam ? (
        <label className="check kn-consent">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} data-testid="connector-consent" />
          <span>{TEAM_RULE_SENTENCE}</span>
        </label>
      ) : (
        <p className="mi-help">Only you can open this base, so everything you can open at the app is added.</p>
      )}
      {error ? <p className="kn-note bad" role="alert" data-testid="connector-error">{error}</p> : null}
      <div className="kn-form-actions">
        <button type="button" className="btn s" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn s primary" disabled={!ready} data-testid="connector-submit">{busy ? 'Adding…' : 'Add and read it now'}</button>
      </div>
    </form>
  );
}
