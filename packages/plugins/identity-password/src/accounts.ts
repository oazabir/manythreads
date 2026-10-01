import type { HttpRequest, PluginContext, PluginTx } from '@manythreads/sdk';
import { HttpError } from '@manythreads/sdk';
import type { AuthenticatedSession, SignInMethod } from '@manythreads/shared';

/** The email as stored for lookups: trimmed and lower-cased (people.primary_email is unique per lower(email)). */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export interface Candidate {
  personId: string;
  workspaceId: string;
  displayName: string;
  email: string;
  status: string;
  /** argon2id hash, or null when the person has no password (OIDC-only). */
  hash: string | null;
  role: string | null;
  /**
   * Whether plain members may use the password form. The ONE source of truth is `workspaces.settings.passwordForMembers`
   * (written by `PATCH /api/workspace`); it only bites while single sign-on is enabled, so a workspace without any
   * working provider can never lock its members out. Admins and owners are not affected (break-glass).
   */
  passwordForMembers: boolean;
}

/** SQL: is an enabled single sign-on provider (google, microsoft, oidc) configured for the workspace column `col`? */
const sso = (col: string): string =>
  `EXISTS (SELECT 1 FROM app.auth_providers ap WHERE ap.workspace_id = ${col} AND ap.kind <> 'password' AND ap.enabled)`;

/** The effective switch: off only when the setting is the literal `false` AND single sign-on is available instead. */
const membersMayUsePassword = (pfm: string | null, ssoEnabled: boolean): boolean => pfm !== 'false' || !ssoEnabled;

/** People with this primary email, oldest first. Runs as system: sign-in happens before anyone is known. */
export async function findCandidates(tx: PluginTx, email: string): Promise<Candidate[]> {
  const res = await tx.query<{
    id: string;
    workspace_id: string;
    display_name: string;
    primary_email: string;
    status: string;
    hash: string | null;
    role: string | null;
    pfm: string | null;
    sso: boolean;
  }>(
    `SELECT p.id, p.workspace_id, p.display_name, p.primary_email, p.status, pc.hash, wm.role,
            w.settings ->> 'passwordForMembers' AS pfm,
            ${sso('p.workspace_id')} AS sso
     FROM app.people p
     JOIN app.workspaces w ON w.id = p.workspace_id
     LEFT JOIN app.password_credentials pc ON pc.person_id = p.id
     LEFT JOIN app.workspace_members wm ON wm.person_id = p.id AND wm.workspace_id = p.workspace_id
     WHERE lower(p.primary_email) = $1
     ORDER BY p.created_at, p.id`,
    [email],
  );
  return res.rows.map((r) => ({
    personId: r.id,
    workspaceId: r.workspace_id,
    displayName: r.display_name,
    email: r.primary_email,
    status: r.status,
    hash: r.hash,
    role: r.role,
    passwordForMembers: membersMayUsePassword(r.pfm, r.sso),
  }));
}

/** May this person use the password form? Admins and owners always can (break-glass); members only when it is on. */
export function passwordAllowed(c: Pick<Candidate, 'role' | 'passwordForMembers'>): boolean {
  if (c.role === 'owner' || c.role === 'admin') return true;
  return c.passwordForMembers;
}

const LABELS: Record<string, string> = {
  password: 'Email and password',
  google: 'Google',
  microsoft: 'Microsoft',
  oidc: 'Single sign-on',
};

/**
 * Sign-in methods the workspace shows. Password is listed unless members may not use it (`passwordForMembers` off while
 * single sign-on is enabled); a signed-in admin or owner (`admin: true`) always sees it, because break-glass keeps working.
 */
export async function loadMethods(tx: PluginTx, workspaceId: string, opts: { admin?: boolean } = {}): Promise<SignInMethod[]> {
  const res = await tx.query<{ kind: SignInMethod['kind']; enabled: boolean; name: string | null }>(
    `SELECT kind, enabled, config ->> 'name' AS name FROM app.auth_providers WHERE workspace_id = $1 AND kind <> 'password' ORDER BY created_at, id`,
    [workspaceId],
  );
  const setting = await tx.query<{ pfm: string | null }>(
    `SELECT settings ->> 'passwordForMembers' AS pfm FROM app.workspaces WHERE id = $1`,
    [workspaceId],
  );
  const ssoEnabled = res.rows.some((r) => r.enabled);
  const methods: SignInMethod[] = [];
  if (opts.admin || membersMayUsePassword(setting.rows[0]?.pfm ?? null, ssoEnabled)) {
    methods.push({ kind: 'password', label: LABELS['password'] ?? 'Password' });
  }
  for (const r of res.rows) {
    if (!r.enabled) continue;
    methods.push({ kind: r.kind, label: r.kind === 'oidc' && r.name ? r.name : (LABELS[r.kind] ?? r.kind) });
  }
  return methods;
}

/** The workspace the sign-in page is for: the oldest (an instance hosts one workspace today). */
export async function firstWorkspaceId(tx: PluginTx): Promise<string | null> {
  const res = await tx.query<{ id: string }>('SELECT id FROM app.workspaces ORDER BY created_at, id LIMIT 1');
  return res.rows[0]?.id ?? null;
}

/** The `GET /api/session` payload of a signed-in person. Null when the person has no membership (nothing to show). */
export async function loadAuthenticated(
  tx: PluginTx,
  personId: string,
  expiresAt: string,
): Promise<AuthenticatedSession | null> {
  const who = await tx.query<{
    id: string;
    display_name: string;
    primary_email: string;
    workspace_id: string;
    workspace_name: string;
    role: AuthenticatedSession['role'];
  }>(
    `SELECT p.id, p.display_name, p.primary_email, w.id AS workspace_id, w.name AS workspace_name, wm.role
     FROM app.people p
     JOIN app.workspaces w ON w.id = p.workspace_id
     JOIN app.workspace_members wm ON wm.person_id = p.id AND wm.workspace_id = p.workspace_id
     WHERE p.id = $1`,
    [personId],
  );
  const row = who.rows[0];
  if (!row) return null;
  const teams = await tx.query<{ slug: string; name: string; role: 'lead' | 'member' }>(
    `SELECT t.slug, t.name, tm.role
     FROM app.actors a
     JOIN app.team_members tm ON tm.actor_id = a.id
     JOIN app.teams t ON t.id = tm.team_id AND t.archived_at IS NULL
     WHERE a.kind = 'person' AND a.ref_id = $1
     ORDER BY t.name, t.id`,
    [personId],
  );
  return {
    authenticated: true,
    person: { id: row.id as never, name: row.display_name, email: row.primary_email },
    workspace: { id: row.workspace_id as never, name: row.workspace_name },
    role: row.role,
    teams: teams.rows,
    methods: await loadMethods(tx, row.workspace_id, { admin: row.role === 'owner' || row.role === 'admin' }),
    expiresAt,
  };
}

/** The caller's person and session, or a 401 (a dev-header actor has neither). */
export function requireSession(req: HttpRequest): { personId: string; sessionId: string; workspaceId: string } {
  const c = req.caller;
  if (!c?.personId || !c.sessionId) throw new HttpError(401, 'unauthenticated', 'Sign in required');
  return { personId: c.personId, sessionId: c.sessionId, workspaceId: c.workspaceId };
}

/** Standard error body for responses that must keep their transaction (so they are returned, not thrown). */
export const errorBody = (code: 'unauthenticated' | 'forbidden' | 'rate_limited' | 'gone' | 'not_found', message: string) => ({
  error: { code, message },
});

export type Ctx = PluginContext;
