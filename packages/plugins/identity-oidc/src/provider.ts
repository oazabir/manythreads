import {
  GOOGLE_ISSUER,
  microsoftIssuer,
  OidcProviderKind,
  type OidcProvider,
  type OidcTestResult,
} from '@manythreads/shared';

/** What `auth_providers.config` holds for the three OIDC kinds. No secret ever goes in here. */
export interface StoredConfig {
  /** The sign-in button text. Stored as `name`, the key the session discovery (identity-password) reads for OIDC. */
  name: string;
  clientId: string;
  /** Any-OIDC only. */
  issuer?: string;
  /** Microsoft only. */
  tenantId?: string;
  lastTest?: OidcTestResult;
}

/** A row of `app.auth_providers` as the queries here select it. */
export type ProviderRow = {
  id: string;
  workspace_id: string;
  kind: string;
  config: unknown;
  secret_id: string | null;
  enabled: boolean;
  allowed_domains: string[];
  disabled_reason: string | null;
  created_at: Date;
  updated_at: Date;
};

export const PROVIDER_COLUMNS =
  'id, workspace_id, kind, config, secret_id, enabled, allowed_domains, disabled_reason, created_at, updated_at';
export const OIDC_KINDS = OidcProviderKind.options;

const DEFAULT_LABELS: Record<OidcProviderKind, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
  oidc: 'Single sign-on',
};
export const defaultLabel = (kind: OidcProviderKind): string => DEFAULT_LABELS[kind];

export const isOidcKind = (kind: string): kind is OidcProviderKind => (OIDC_KINDS as readonly string[]).includes(kind);

/**
 * Development and test only: `MANYTHREADS_OIDC_MOCK_BASE=http://localhost:8080` makes the Google and Microsoft presets
 * talk to `<base>/google` and `<base>/microsoft` (the mock issuer in tools/mock-oidc) instead of the real endpoints.
 * Ignored when NODE_ENV is `production`. Read on every use so tests can set it per case.
 */
export function mockBase(): string | null {
  if (process.env['NODE_ENV'] === 'production') return null;
  const base = process.env['MANYTHREADS_OIDC_MOCK_BASE']?.trim();
  return base ? base.replace(/\/+$/, '') : null;
}

export function readConfig(raw: unknown): StoredConfig {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
  const last = c['lastTest'] as Record<string, unknown> | undefined;
  return {
    name: text(c['name']) ?? '',
    clientId: text(c['clientId']) ?? '',
    ...(text(c['issuer']) ? { issuer: text(c['issuer']) as string } : {}),
    ...(text(c['tenantId']) ? { tenantId: text(c['tenantId']) as string } : {}),
    ...(last && typeof last['ok'] === 'boolean' && typeof last['message'] === 'string' && typeof last['checkedAt'] === 'string'
      ? { lastTest: { ok: last['ok'], message: last['message'], checkedAt: last['checkedAt'] } }
      : {}),
  };
}

/** The issuer URL the provider is discovered at. */
export function issuerFor(kind: OidcProviderKind, config: Pick<StoredConfig, 'issuer' | 'tenantId'>): string {
  const mock = mockBase();
  if (mock && kind === 'google') return `${mock}/google`;
  if (mock && kind === 'microsoft') return `${mock}/microsoft`;
  if (kind === 'google') return GOOGLE_ISSUER;
  if (kind === 'microsoft') return microsoftIssuer(config.tenantId ?? '');
  return config.issuer ?? '';
}

export const callbackUrl = (publicUrl: string): string => `${publicUrl}/api/auth/oidc/callback`;

/** Row to the admin response. `hasSecret` is the only trace of the client secret. */
export function toOidcProvider(row: ProviderRow, publicUrl: string): OidcProvider {
  const kind = OidcProviderKind.parse(row.kind);
  const config = readConfig(row.config);
  return {
    id: row.id as OidcProvider['id'],
    kind,
    label: config.name || defaultLabel(kind),
    clientId: config.clientId,
    issuer: issuerFor(kind, config),
    tenantId: config.tenantId ?? null,
    allowedDomains: row.allowed_domains,
    enabled: row.enabled,
    disabledReason: row.disabled_reason,
    hasSecret: row.secret_id !== null,
    callbackUrl: callbackUrl(publicUrl),
    lastTest: config.lastTest ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
