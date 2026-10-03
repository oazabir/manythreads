import { useState, type FormEvent } from 'react';
import type { CreateOidcProviderRequest, OidcProvider, OidcProviderKind, OidcTestResult } from '@manythreads/shared';
import { isApiError } from '../api/client';
import {
  createOidcProvider,
  deleteOidcProvider,
  disableOidcProvider,
  enableOidcProvider,
  fetchOidcProviders,
  fetchWorkspace,
  testOidcProvider,
  updateOidcProvider,
  updateWorkspace,
} from '../api/endpoints';
import { useQuery } from '../app/useQuery';
import { QueryView } from '../components/states';
import { Alert, Field, Time, Toggle } from '../components/ui';

const TITLES: Record<OidcProviderKind, string> = { google: 'Google Workspace', microsoft: 'Microsoft 365 / Teams', oidc: 'Any other OIDC provider' };


const splitDomains = (raw: string): string[] => raw.split(/[\s,;]+/).filter(Boolean);
const failure = (e: unknown, fallback = 'Something went wrong. Try again.'): string => (isApiError(e) ? e.message : fallback);

function StatusChip({ p, kind }: { p: OidcProvider | undefined; kind: OidcProviderKind }) {
  if (!p) return <span className="chip no">{kind === 'oidc' ? 'optional' : 'not configured'}</span>;
  if (p.enabled) return <span className="status ok">enabled</span>;
  if (p.disabledReason) return <span className="status bad">error</span>;
  return <span className="chip no">disabled</span>;
}

/**
 * One provider preset. The secret is write-only: the field is empty and only says whether one is stored (`hasSecret`).
 * A failed discovery leaves the provider disabled and shows its reason.
 */
function ProviderBox({ kind, initial, onChanged }: { kind: OidcProviderKind; initial: OidcProvider | undefined; onChanged: () => void }) {
  const [p, setP] = useState<OidcProvider | undefined>(initial);
  const [secret, setSecret] = useState('');
  const [domains, setDomains] = useState((initial?.allowedDomains ?? []).join(', '));
  const [clientId, setClientId] = useState(initial?.clientId ?? '');
  const [tenantId, setTenantId] = useState(initial?.tenantId ?? '');
  const [issuer, setIssuer] = useState(initial && kind === 'oidc' ? initial.issuer : '');
  const [result, setResult] = useState<OidcTestResult | null>(initial?.lastTest ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function guard(fn: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }

  async function save(): Promise<OidcProvider | undefined> {
    if (p) {
      const res = await updateOidcProvider(p.id, {
        clientId,
        allowedDomains: splitDomains(domains),
        ...(secret === '' ? {} : { clientSecret: secret }),
        ...(kind === 'microsoft' ? { tenantId } : {}),
        ...(kind === 'oidc' ? { issuer } : {}),
      });
      setP(res.provider);
      setResult(res.provider.lastTest);
      setSecret('');
      return res.provider;
    }
    const base = { clientId, clientSecret: secret, allowedDomains: splitDomains(domains), enabled: true };
    const body: CreateOidcProviderRequest =
      kind === 'google' ? { kind, ...base }
      : kind === 'microsoft' ? { kind, ...base, tenantId }
      : { kind, ...base, issuer };
    const res = await createOidcProvider(body);
    setP(res.provider);
    setResult(res.provider.lastTest);
    setSecret('');
    onChanged();
    return res.provider;
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void guard(async () => void (await save()));
  };

  const onTest = () =>
    guard(async () => {
      if (!p) return;
      const saved = await save();
      if (!saved) return;
      const res = await testOidcProvider(saved.id);
      setP(res.provider);
      setResult(res.result);
    });

  const onToggle = (on: boolean) =>
    guard(async () => {
      if (!p) return;
      const res = await (on ? enableOidcProvider(p.id) : disableOidcProvider(p.id));
      setP(res.provider);
      setResult(res.provider.lastTest);
      onChanged();
    });

  const onRemove = () =>
    guard(async () => {
      if (!p) return;
      await deleteOidcProvider(p.id);
      onChanged();
    });

  const titleId = `prov-${kind}-${p?.id ?? 'new'}`;
  return (
    <form className="box" onSubmit={onSubmit} aria-labelledby={titleId} data-landmark={`provider-${kind}`} noValidate>
      <h2 className="box-h" id={titleId}>
        {TITLES[kind]} <StatusChip p={p} kind={kind} />
        {p ? <span className="push"><Toggle label={`Enable ${TITLES[kind]}`} checked={p.enabled} disabled={busy} onChange={(v) => void onToggle(v)} /></span> : null}
      </h2>
      {kind === 'microsoft' ? <Field label="Tenant ID" value={tenantId} onChange={(e) => setTenantId(e.target.value)} placeholder="from Entra ID (a GUID)" autoComplete="off" /> : null}
      {kind === 'oidc' ? <Field label="Issuer URL" value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="https://…" autoComplete="off" /> : null}
      <Field label="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="app registration" autoComplete="off" />
      <Field
        label="Client secret"
        type="password"
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        placeholder={p?.hasSecret ? '●●●● stored, type to replace' : 'app registration'}
        autoComplete="new-password"
      />
      <Field label="Allowed domains" value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="e.g. kahf.co" hint={kind === 'google' ? 'Required: only these domains can sign in.' : kind === 'microsoft' ? 'Optional. Also limits sign-in to the tenant above.' : 'Optional.'} />
      {p ? <div className="fld-hint">Register this redirect URI with the provider: <span className="mono">{p.callbackUrl}</span></div> : null}
      {p && !p.enabled && p.disabledReason ? <Alert>{p.disabledReason}</Alert> : null}
      {result ? (
        result.ok
          ? <div className="test ok" role="status">{result.message} <Time iso={result.checkedAt} /></div>
          : <Alert>{result.message}</Alert>
      ) : null}
      {error ? <Alert>{error}</Alert> : null}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={busy}>{p ? 'Save' : 'Add'}</button>
        {p ? <button type="button" className="btn" disabled={busy} onClick={() => void onTest()}>Test</button> : null}
        {p ? <button type="button" className="btn" disabled={busy} onClick={() => void onRemove()}>Remove</button> : null}
      </div>
    </form>
  );
}

/**
 * Username and password. The switch is the workspace setting `passwordForMembers` (the same one General shows):
 * off sends members to single sign-on, admins keep the form as break-glass.
 */
function PasswordBox() {
  const q = useQuery('workspace-password-setting', fetchWorkspace);
  const [override, setOverride] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const on = override ?? (q.status === 'ok' ? q.data.workspace.passwordForMembers : true);

  async function set(value: boolean) {
    setError(null);
    setBusy(true);
    try {
      const { workspace } = await updateWorkspace({ passwordForMembers: value });
      setOverride(workspace.passwordForMembers);
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="box" aria-labelledby="prov-password" data-landmark="provider-password">
      <h2 className="box-h" id="prov-password">
        Username and password
        <span className="push">
          <span className={on ? 'status ok' : 'chip no'}>{on ? 'on' : 'off for members'}</span>{' '}
          <Toggle label="Members can sign in with a password" checked={on} disabled={busy || q.status !== 'ok'} onChange={(v) => void set(v)} />
        </span>
      </h2>
      <div className="fld"><span className="fld-label">Password policy</span><div className="inp-static">min 8 characters</div></div>
      <div className="fld-hint">Admins keep username and password as a break-glass login even when single sign-on is the only method for members.</div>
      {error ? <Alert>{error}</Alert> : null}
    </section>
  );
}

export function SignInMethods() {
  const q = useQuery('oidc-providers', fetchOidcProviders);
  return (
    <div className="signin-methods" data-landmark="signin-methods">
      <h1 className="pane-title" data-landmark="title">How will people sign in?</h1>
      <p className="lede" data-landmark="lede">Add a preset for Google or Microsoft, and decide whether username and password stays on alongside it.</p>
      <QueryView q={q}>
        {({ providers }) => {
          const of = (k: OidcProviderKind) => providers.filter((p) => p.kind === k);
          const boxes = (k: OidcProviderKind) => {
            const list = of(k);
            return list.length === 0
              ? [<ProviderBox key={`${k}-new`} kind={k} initial={undefined} onChanged={q.reload} />]
              : list.map((p) => <ProviderBox key={p.id} kind={k} initial={p} onChanged={q.reload} />);
          };
          return (
            <>
              <div className="grid2">
                <section className="box box-col" aria-labelledby="presets-h" data-landmark="presets">
                  <h2 className="box-h" id="presets-h">Presets</h2>
                  {boxes('google')}
                  {boxes('microsoft')}
                </section>
                <div className="box-col">
                  <PasswordBox />
                  {boxes('oidc')}
                </div>
              </div>
              <p className="foot-note">A provider whose discovery fails is saved switched off, with the reason shown here. Secrets are stored encrypted and are never shown again.</p>
            </>
          );
        }}
      </QueryView>
    </div>
  );
}
