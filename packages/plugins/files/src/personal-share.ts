import { HttpError, type PluginContext, type PluginTx, type RepoProvider } from '@manythreads/sdk';
import {
  CopyPersonalFileToTeamRequest,
  CopyPersonalFileToTeamResponse,
  PersonalFilePathParams,
  PersonalShareCheckRequest,
  PersonalShareCheckResponse,
  copyPersonalFileToTeamRoute,
  personalShareCheckRoute,
} from '@manythreads/shared';
import { BlobNotFoundError } from '@manythreads/sdk';
import { forbidden, json, notFound, route } from './http.ts';
import { requireMember, requireOwnFile, type Member } from './personal.ts';
import { storageOf } from './routes.ts';
import { mapRepoError, requireTeam } from './tree.ts';

// Sending a Personal file to a team (P20-14). The data rules (the same chain the model gateway runs before a prompt leaves) look at the text first:
// `share-check` only asks what they say, `copy-to-team` asks again and enforces. The team repo holds text only, so a file that is not UTF-8 text or is
// over 1 MB cannot be copied; the Personal original always stays.

const REPO_TEXT_MAX = 1024 * 1024;

/** The file's text, or null when it is not text the repo accepts (a NUL byte, invalid UTF-8) or is over 1 MB. */
async function readText(ctx: PluginContext, file: { blob_key: string; size: string | number }): Promise<string | null> {
  if (Number(file.size) > REPO_TEXT_MAX) return null;
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of await storageOf(ctx).get(file.blob_key)) {
      total += chunk.byteLength;
      if (total > REPO_TEXT_MAX) return null;
      chunks.push(Buffer.from(chunk));
    }
  } catch (err) {
    if (err instanceof BlobNotFoundError) throw notFound('The file is no longer in storage');
    throw err;
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const notText = (): HttpError =>
  new HttpError(422, 'attachment_not_in_repo', 'Only text files up to 1 MB can be copied into a team’s files. Keep this one in your Personal files.');

/**
 * The workspace's guard preset (what the model gateway keeps with its settings), `standard` when the gateway is not installed. The settings table is
 * readable by admins only, so a member's own transaction would see no row and silently fall back to `standard`; the lookup runs as the system and
 * reads nothing but the preset and the host list.
 */
async function guardPreset(ctx: PluginContext, workspaceId: string): Promise<{ preset: string; allowlist: string[] }> {
  return ctx.db.system(async (sys) => {
    const present = (await sys.query<{ ok: boolean }>(`SELECT to_regclass('app.llm_settings') IS NOT NULL AS ok`)).rows[0]?.ok === true;
    if (!present) return { preset: 'standard', allowlist: [] };
    const row = (await sys.query<{ preset: string; egress_allowlist: string[] }>('SELECT preset, egress_allowlist FROM app.llm_settings WHERE workspace_id = $1::uuid', [workspaceId])).rows[0];
    return { preset: row?.preset ?? 'standard', allowlist: row?.egress_allowlist ?? [] };
  });
}

export function registerPersonalShareRoutes(ctx: PluginContext): void {
  const decide = async (tx: PluginTx, member: Member, teamId: string, destination: string, text: string) => {
    const setup = await guardPreset(ctx, member.workspaceId);
    const decision = await ctx.hooks.runPreEgress(tx, {
      destination,
      workspaceId: member.workspaceId,
      teamId,
      text,
      preset: setup.preset,
      allowlist: setup.allowlist,
      mode: 'preset',
      recorded: false,
    });
    // Nothing guarding the destination is not "allowed": a caller that must be guarded refuses.
    if (decision.hooks === 0) throw new HttpError(503, 'internal', 'The workspace’s data rules are not available, so nothing is sent.');
    return decision;
  };

  ctx.http.route({
    ...personalShareCheckRoute,
    schema: { body: PersonalShareCheckRequest, response: PersonalShareCheckResponse },
    handler: route(async (req, tx) => {
      const member = await requireMember(tx);
      const { fileId } = PersonalFilePathParams.parse(req.params);
      const body = PersonalShareCheckRequest.parse(req.body);
      const file = await requireOwnFile(tx, member, fileId);
      const team = await requireTeam(tx, body.teamSlug);
      const text = await readText(ctx, file);
      if (text === null) {
        // Files the repo cannot take are refused for the team's files; the inbox reads more kinds and its own pipeline checks the extracted text.
        if (body.destination === 'team_files') throw notText();
        return json(PersonalShareCheckResponse.parse({ outcome: 'allow', rules: [] }));
      }
      const decision = await decide(tx, member, team.id, body.destination === 'team_files' ? 'team_files' : 'memory_inbox', text);
      return json(PersonalShareCheckResponse.parse({ outcome: decision.outcome, rules: decision.rules }));
    }),
  });

  ctx.http.route({
    ...copyPersonalFileToTeamRoute,
    schema: { body: CopyPersonalFileToTeamRequest, response: CopyPersonalFileToTeamResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const member = await requireMember(tx);
      const { fileId } = PersonalFilePathParams.parse(req.params);
      const body = CopyPersonalFileToTeamRequest.parse(req.body);
      const file = await requireOwnFile(tx, member, fileId);
      const team = await requireTeam(tx, body.teamSlug);
      if (!team.can_post) throw forbidden('You cannot add files to this team');
      const text = await readText(ctx, file);
      if (text === null) throw notText();
      const decision = await decide(tx, member, team.id, 'team_files', text);
      if (decision.outcome === 'block' || decision.outcome === 'require_approval') {
        throw new HttpError(409, 'conflict', decision.message ?? 'The workspace’s data rules do not let this file go to a team.');
      }
      const redacted = decision.outcome === 'redact';
      const repo = ctx.providers.get<RepoProvider>('repo');
      if (!repo) throw new HttpError(503, 'internal', 'The team repository is not available');
      let result;
      try {
        // `baseBlobSha: null` means the path must not exist yet: a copy never overwrites a team file.
        result = await repo.write(tx, team.id, { id: tx.actor.id, kind: 'person' }, [{ path: body.path, op: 'put', content: redacted ? decision.text : text, baseBlobSha: null }], `Add ${body.path} from Personal files`);
      } catch (err) {
        mapRepoError(err);
      }
      return json(CopyPersonalFileToTeamResponse.parse({ path: body.path, commitSha: result.sha, redacted }));
    }),
  });
}
