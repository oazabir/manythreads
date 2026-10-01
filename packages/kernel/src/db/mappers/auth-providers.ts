import { AuthProvider } from '@majlis/shared';

export interface AuthProviderRow {
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
}

export const toAuthProvider = (row: AuthProviderRow): AuthProvider =>
  AuthProvider.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    config: row.config,
    secretId: row.secret_id,
    enabled: row.enabled,
    allowedDomains: row.allowed_domains,
    disabledReason: row.disabled_reason,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
