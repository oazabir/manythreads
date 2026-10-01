import { useState, type FormEvent } from 'react';
import { isApiError } from '../api/client';
import { fetchSignInSettings, saveProvider, savePasswordPolicy, testProvider } from '../api/endpoints';
import type { PasswordPolicy, ProviderConfig, ProviderKind, ProviderTestResult } from '../api/schemas';
import { useQuery } from '../app/useQuery';
import { QueryView } from '../components/states';
import { Alert, Field, Toggle } from '../components/ui';

const TITLES: Record<ProviderKind, string> = { google: 'Google Workspace', microsoft: 'Microsoft 365 / Teams', oidc: 'Any other OIDC provider' };

function StatusChip({ p }: { p: ProviderConfig }) {
  if (p.status === 'verified') return <span className="status ok">verified</span>;
  if (p.status === 'error') return <span className="status bad">error</span>;
  return <span className="chip no">{p.kind === 'oidc' ? 'optional' : 'not configured'}</span>;
}

/** One provider preset. The secret is write-only: the field is empty and says whether one is stored. */
function ProviderBox({ initial, onSaved }: { initial: ProviderConfig; onSaved: () => void }) {
  const [p, setP] = useState(initial);
  const [secret, setSecret] = useState('');
  const [domains, setDomains] = useState(initial.domains.join(', '));
  const [clientId, setClientId] = useState(initial.clientId);
  const [tenantId, setTenantId] = useState(initial.tenantId ?? '');
  const [issuer, setIssuer] = useState(initial.issuer ?? '');
  const [result, setResult] = useState<ProviderTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(enabled: boolean): Promise<ProviderConfig | null> {
    setError(null);
    try {
      const saved = await saveProvider(p.kind, {
        enabled,
        clientId,
        clientSecret: secret === '' ? undefined : secret,
        domains: domains.split(/[\s,]+/).filter(Boolean),
        tenantId: p.kind === 'microsoft' ? tenantId : null,
        issuer: p.kind === 'oidc' ? issuer : null,
      });
      setP(saved);
      setSecret('');
      onSaved();
      return saved;
    } catch (e) {
      setError(isApiError(e) ? e.message : 'Something went wrong. Try again.');
      return null;
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    await save(p.enabled);
    setBusy(false);
  }

  async function onTest() {
    setBusy(true);
    setResult(null);
    const saved = await save(p.enabled);
    if (saved) {
      try {
        const r = await testProvider(p.kind);
        setResult(r);
        // a failed discovery leaves the provider disabled; reflect it
        setP((cur) => ({ ...cur, enabled: r.ok ? cur.enabled : false, status: r.ok ? 'verified' : cur.kind === 'oidc' ? 'error' : cur.status, statusDetail: r.detail }));
      } catch (e) {
        setError(isApiError(e) ? e.message : 'Test failed.');
      }
    }
    setBusy(false);
  }

  const titleId = `prov-${p.kind}`;
  return (
    <form className="box" onSubmit={onSubmit} aria-labelledby={titleId} data-landmark={`provider-${p.kind}`} noValidate>
      <h2 className="box-h" id={titleId}>
        {TITLES[p.kind]} <StatusChip p={p} />
        <span className="push"><Toggle label={`Enable ${TITLES[p.kind]}`} checked={p.enabled} onChange={(v) => setP({ ...p, enabled: v })} /></span>
      </h2>
      {p.kind === 'microsoft' ? <Field label="Tenant ID" value={tenantId} onChange={(e) => setTenantId(e.target.value)} placeholder="from Entra ID" /> : null}
      {p.kind === 'oidc' ? <Field label="Issuer URL" value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="https://…" /> : null}
      <Field label="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder={p.kind === 'microsoft' ? 'app registration' : p.kind === 'oidc' ? 'optional' : ''} autoComplete="off" />
      <Field
        label="Client secret"
        type="password"
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        placeholder={p.secretSet ? '●●●● stored, type to replace' : p.kind === 'oidc' ? 'optional' : 'app registration'}
        autoComplete="new-password"
      />
      {p.kind !== 'oidc' ? <Field label="Allowed domains" value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="e.g. kahf.co" /> : null}
      {p.kind === 'microsoft' ? <div className="fld-hint">Uses Entra ID. Also covers sign-in from Teams.</div> : null}
      {p.status === 'error' && p.statusDetail && !result ? <Alert>{p.statusDetail}</Alert> : null}
      {result ? (result.ok ? <div className="test ok" role="status">{result.detail}</div> : <Alert>{result.detail}</Alert>) : null}
      {error ? <Alert>{error}</Alert> : null}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={busy}>Save</button>
        <button type="button" className="btn" disabled={busy} onClick={onTest}>Test</button>
      </div>
    </form>
  );
}

function PasswordBox({ initial }: { initial: PasswordPolicy }) {
  const [pol, setPol] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  async function update(next: PasswordPolicy) {
    const before = pol;
    setPol(next);
    setError(null);
    try {
      setPol(await savePasswordPolicy({ enabled: next.enabled, requireVerification: next.requireVerification, allowSelfSignup: next.allowSelfSignup }));
    } catch (e) {
      setPol(before);
      setError(isApiError(e) ? e.message : 'Something went wrong. Try again.');
    }
  }

  return (
    <section className="box" aria-labelledby="prov-password" data-landmark="provider-password">
      <h2 className="box-h" id="prov-password">
        Username and password
        <span className="push"><Toggle label="Enable username and password" checked={pol.enabled} onChange={(v) => update({ ...pol, enabled: v })} /></span>
      </h2>
      <div className="fld"><span className="fld-label">Password policy</span><div className="inp-static">min {pol.minLength} characters</div></div>
      <div className="trow2"><div>Require email verification</div><Toggle label="Require email verification" checked={pol.requireVerification} onChange={(v) => update({ ...pol, requireVerification: v })} /></div>
      <div className="trow2"><div>Allow self-signup<div className="d">{pol.allowSelfSignup ? 'anyone with an allowed domain' : 'invite only'}</div></div><Toggle label="Allow self-signup" checked={pol.allowSelfSignup} onChange={(v) => update({ ...pol, allowSelfSignup: v })} /></div>
      {error ? <Alert>{error}</Alert> : null}
    </section>
  );
}

export function SignInMethods() {
  const q = useQuery('sign-in-settings', fetchSignInSettings);
  return (
    <>
      <h1 className="pane-title">How will people sign in?</h1>
      <p className="lede">Add a preset for Google or Microsoft, and decide whether username and password stays on alongside it.</p>
      <QueryView q={q}>
        {(settings) => {
          const byKind = (k: ProviderKind) => settings.providers.find((p) => p.kind === k);
          const google = byKind('google');
          const microsoft = byKind('microsoft');
          const oidc = byKind('oidc');
          return (
            <>
              <div className="grid2">
                <section className="box box-col" aria-labelledby="presets-h">
                  <h2 className="box-h" id="presets-h">Presets</h2>
                  {google ? <ProviderBox initial={google} onSaved={q.reload} /> : null}
                  {microsoft ? <ProviderBox initial={microsoft} onSaved={q.reload} /> : null}
                </section>
                <div className="box-col">
                  <PasswordBox initial={settings.password} />
                  {oidc ? <ProviderBox initial={oidc} onSaved={q.reload} /> : null}
                </div>
              </div>
              <p className="foot-note">Admins keep username and password as a break-glass login even when OAuth is on.</p>
            </>
          );
        }}
      </QueryView>
    </>
  );
}
