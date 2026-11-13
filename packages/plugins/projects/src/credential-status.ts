import type { CredentialTeam, PluginTx, ProjectCredentialsProvider } from '@manythreads/sdk';
import type { TokenCheck } from './github-check.ts';
import { COLUMNS, ownerKeyOf, type ProjectRow } from './rows.ts';

/**
 * Keep what GitHub just said about a project's stored token: `ok` (with the expiry GitHub reports) or `needs_replacing`. The same rule serves the
 * "Test connection" button and the job that asks GitHub on its own, so the page and the bots never disagree.
 *
 *  - A token shared by every project of one GitHub owner is one token: when GitHub turns it down (401) every project on it is marked. An answer of "ok" is
 *    about the project that was asked: it marks that project good and only refreshes the expiry of the others that are good already; a project that is
 *    marked for something about its own repository (the token cannot write there, or belongs to another account) stays marked. A refusal that is about
 *    this repository only marks this project alone.
 *  - Rows are written only when something changes, so a good token that stays good leaves `updated_at` and the history alone.
 *  - The team pod is told as well (`setRefused`), so the publish command and the pull-request sync stop using a token GitHub does not accept, and use
 *    it again once it is accepted. `podRefused` says whether the pod's mark is set already (the pod is then asked only when that changes). That call is
 *    best effort: the page's status is the record, and the next check repeats it.
 *
 * `checked` must not be `unreachable`: a GitHub that did not answer changes nothing. Returns this project's row as it is now.
 */
export async function recordCheck(
  tx: PluginTx,
  provider: ProjectCredentialsProvider | undefined,
  team: CredentialTeam,
  current: ProjectRow,
  checked: TokenCheck,
  opts: { podRefused?: boolean } = {},
): Promise<ProjectRow | undefined> {
  const ownerKey = current.push_credential_shared ? ownerKeyOf(current.repo_url, current.provider) : null;
  const tokenDead = !checked.ok && checked.problem === 'rejected';
  let mates: string[] = [];
  if (ownerKey !== null && (checked.ok || tokenDead)) {
    const sharing = await tx.query<ProjectRow>(`SELECT ${COLUMNS} FROM app.projects WHERE team_id = $1::uuid AND push_credential_shared AND id <> $2::uuid`, [team.id, current.id]);
    mates = sharing.rows.filter((r) => ownerKeyOf(r.repo_url, r.provider) === ownerKey).map((r) => r.id);
  }
  if (checked.ok) {
    await tx.query(
      `UPDATE app.projects SET push_credential_status = 'ok', push_credential_expires_at = COALESCE($4::timestamptz, push_credential_expires_at), updated_at = now()
        WHERE team_id = $1::uuid AND push_credential_set_at IS NOT NULL AND (id = $2::uuid OR (id = ANY ($3::uuid[]) AND push_credential_status = 'ok'))
          AND (push_credential_status IS DISTINCT FROM 'ok' OR ($4::timestamptz IS NOT NULL AND push_credential_expires_at IS DISTINCT FROM $4::timestamptz))`,
      [team.id, current.id, mates, checked.expiresAt],
    );
  } else {
    await tx.query(
      `UPDATE app.projects SET push_credential_status = 'needs_replacing', updated_at = now()
        WHERE team_id = $1::uuid AND push_credential_set_at IS NOT NULL AND id = ANY ($2::uuid[]) AND push_credential_status IS DISTINCT FROM 'needs_replacing'`,
      [team.id, [current.id, ...mates]],
    );
  }
  if (provider) {
    // for a project on its own token any refusal stops the pod; for a shared token only a dead token does (a repository-only refusal would stop the others)
    const refused = !checked.ok && (ownerKey === null || tokenDead);
    if (refused !== (opts.podRefused ?? false)) await provider.setRefused(team, current.name, refused).catch(() => undefined);
  }
  return (await tx.query<ProjectRow>(`SELECT ${COLUMNS} FROM app.projects WHERE team_id = $1::uuid AND id = $2::uuid`, [team.id, current.id])).rows[0];
}
