import type { PluginContext, PluginTx } from '@manythreads/sdk';
import type { OidcSignInErrorCode } from '@manythreads/shared';

export interface LinkInput {
  workspaceId: string;
  providerId: string;
  subject: string;
  /** Lower-case address the provider asserted (already checked against the provider's rules). */
  email: string;
  name: string;
}

export type LinkOutcome =
  | { ok: true; personId: string; createdPerson: boolean }
  | { ok: false; reason: OidcSignInErrorCode };

type Invitation = {
  id: string;
  team_id: string | null;
  role: 'admin' | 'member' | 'guest';
  grant_spec: { teamRole?: unknown } | null;
};

/**
 * Finds or creates the person for a verified provider identity, inside the caller's system transaction. Everything is
 * scoped to the provider's workspace: the identity lookup is by provider (which belongs to one workspace), the email
 * lookup filters on that workspace, and a new person is created only there. Nothing here can reach another workspace.
 *
 * 1. The (provider, subject) identity exists: that person (refused when suspended).
 * 2. A person of this workspace has the email: link it. The local address must be verified, or the person must have no
 *    password (so no one can have claimed the account with an unverified address and a password of their own). A person
 *    already linked to another subject at this provider is refused, not silently given a second login.
 * 3. No such person: create one only when the workspace allows self sign-up or an open invitation names the address.
 */
export async function linkPerson(ctx: PluginContext, tx: PluginTx, input: LinkInput): Promise<LinkOutcome> {
  const { workspaceId, providerId, subject, email } = input;
  // One sign-in per (workspace, address) at a time, so a double click cannot create two people.
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`oidc:${workspaceId}:${email}`]);

  const known = await tx.query<{ person_id: string; status: string }>(
    `SELECT i.person_id, p.status
       FROM app.identities i JOIN app.people p ON p.id = i.person_id AND p.workspace_id = i.workspace_id
      WHERE i.provider_id = $1 AND i.subject = $2 AND i.workspace_id = $3`,
    [providerId, subject, workspaceId],
  );
  const identity = known.rows[0];
  if (identity) {
    return identity.status === 'active'
      ? { ok: true, personId: identity.person_id, createdPerson: false }
      : { ok: false, reason: 'account_suspended' };
  }

  const byEmail = await tx.query<{
    id: string;
    status: string;
    primary_match: boolean;
    verified: boolean;
    has_password: boolean;
    other_subject: boolean;
  }>(
    `SELECT p.id, p.status,
            lower(p.primary_email) = $2 AS primary_match,
            EXISTS (SELECT 1 FROM app.person_emails e
                     WHERE e.person_id = p.id AND lower(e.email) = $2 AND e.verified_at IS NOT NULL) AS verified,
            EXISTS (SELECT 1 FROM app.password_credentials c WHERE c.person_id = p.id) AS has_password,
            EXISTS (SELECT 1 FROM app.identities i WHERE i.person_id = p.id AND i.provider_id = $3) AS other_subject
       FROM app.people p
      WHERE p.workspace_id = $1
        AND (lower(p.primary_email) = $2
             OR EXISTS (SELECT 1 FROM app.person_emails e
                         WHERE e.person_id = p.id AND lower(e.email) = $2 AND e.verified_at IS NOT NULL))
      ORDER BY p.created_at
      LIMIT 1`,
    [workspaceId, email, providerId],
  );
  const person = byEmail.rows[0];
  if (person) {
    if (person.status !== 'active') return { ok: false, reason: 'account_suspended' };
    if (person.other_subject) return { ok: false, reason: 'identity_mismatch' };
    if (!person.verified && !(person.primary_match && !person.has_password)) {
      return { ok: false, reason: 'account_unverified' };
    }
    await linkIdentity(tx, input, person.id);
    return { ok: true, personId: person.id, createdPerson: false };
  }

  const ws = await tx.query<{ self_signup: boolean }>('SELECT self_signup FROM app.workspaces WHERE id = $1', [workspaceId]);
  const inv = await tx.query<Invitation>(
    `SELECT id, team_id, role, grant_spec FROM app.invitations
      WHERE workspace_id = $1 AND lower(email) = $2 AND accepted_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`,
    [workspaceId, email],
  );
  const invitation = inv.rows[0];
  if (!ws.rows[0]?.self_signup && !invitation) return { ok: false, reason: 'signup_closed' };

  const role = invitation?.role ?? 'member';
  const created = await tx.query<{ id: string }>(
    'INSERT INTO app.people (workspace_id, display_name, primary_email) VALUES ($1, $2, $3) RETURNING id',
    [workspaceId, input.name, email],
  );
  const personId = (created.rows[0] as { id: string }).id;
  // person_emails.email is unique across workspaces; when another workspace holds the address only people.primary_email records it here.
  await tx.query(
    'INSERT INTO app.person_emails (workspace_id, person_id, email, verified_at) VALUES ($1, $2, $3, now()) ON CONFLICT DO NOTHING',
    [workspaceId, personId, email],
  );
  await tx.query('INSERT INTO app.workspace_members (workspace_id, person_id, role) VALUES ($1, $2, $3)', [
    workspaceId,
    personId,
    role,
  ]);
  const actorId = await ctx.identity.ensureActor(tx, { workspaceId, personId });
  await linkIdentity(tx, input, personId);

  if (invitation) {
    await tx.query('UPDATE app.invitations SET accepted_at = now() WHERE id = $1', [invitation.id]);
    const teamRole = invitation.grant_spec?.teamRole === 'lead' ? 'lead' : 'member';
    if (invitation.team_id) {
      await tx.query(
        'INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [invitation.team_id, actorId, workspaceId, teamRole],
      );
      await ctx.events.emit(tx, {
        type: 'team.member.added',
        schemaVersion: 1,
        workspaceId,
        teamId: invitation.team_id,
        personId,
        role: teamRole,
      });
    }
    await ctx.events.emit(tx, {
      type: 'workspace.invitation.accepted',
      schemaVersion: 1,
      workspaceId,
      teamId: invitation.team_id,
      invitationId: invitation.id,
      personId,
      role,
      teamRole: invitation.team_id ? teamRole : null,
      createdPerson: true,
    });
  }
  return { ok: true, personId, createdPerson: true };
}

async function linkIdentity(tx: PluginTx, input: LinkInput, personId: string): Promise<void> {
  await tx.query(
    `INSERT INTO app.identities (workspace_id, person_id, provider_id, subject) VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider_id, subject) DO NOTHING`,
    [input.workspaceId, personId, input.providerId, input.subject],
  );
}
