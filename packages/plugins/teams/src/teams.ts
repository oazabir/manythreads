import type { PluginDb, PluginTemplates, PluginTx } from '@manythreads/sdk';
import type { TeamTemplate } from '@manythreads/shared';
import { conflict, forbidden, HttpError, notFound } from './http.ts';
import { TEAM_WITH_COUNTS, type TeamRow } from './rows.ts';

/** Emits a registry event for the caller's workspace; wired to `ctx.events.emit` in index.ts. */
export type EmitTeamEvent = (tx: PluginTx, event: { type: string; [field: string]: unknown }) => Promise<void>;

export interface Deps {
  emit: EmitTeamEvent;
  /** `ctx.templates`: the shipped templates (read once, cached by the kernel). */
  templates: PluginTemplates;
  /** `ctx.db`: the kernel's get-or-create. */
  db: PluginDb;
}

/** `Core Platform` -> `core-platform`. Empty when the text has no letters or digits. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 63)
    .replace(/-+$/, '');
}

export const slugFor = (name: string, slug: string | undefined): string => {
  const out = slug ?? slugify(name);
  if (out === '') throw new HttpError(400, 'name: needs letters or digits (or pass a slug)');
  return out;
};

export async function findTeam(tx: PluginTx, slug: string): Promise<TeamRow | undefined> {
  const res = await tx.query<TeamRow>(`SELECT ${TEAM_WITH_COUNTS} FROM app.teams t WHERE t.slug = $1`, [slug]);
  return res.rows[0];
}

export async function teamById(tx: PluginTx, id: string): Promise<TeamRow> {
  const res = await tx.query<TeamRow>(`SELECT ${TEAM_WITH_COUNTS} FROM app.teams t WHERE t.id = $1`, [id]);
  const row = res.rows[0];
  if (!row) throw notFound('Team not found');
  return row;
}

export async function isWorkspaceAdmin(tx: PluginTx): Promise<boolean> {
  const res = await tx.query<{ admin: boolean }>('SELECT app.is_workspace_admin() AS admin');
  return res.rows[0]?.admin === true;
}

/**
 * The team the caller may see. A team the caller cannot see is 403 (never 404 for a non-admin, so existence is not
 * revealed); a workspace admin sees every team, so for them a missing slug is a plain 404.
 */
export async function requireTeam(tx: PluginTx, slug: string): Promise<TeamRow> {
  const team = await findTeam(tx, slug);
  if (team) return team;
  if (await isWorkspaceAdmin(tx)) throw notFound('Team not found');
  throw forbidden('You are not a member of this team');
}

/** Lead or workspace admin (`manage`); anyone else on the team is 403. */
export async function requireManage(tx: PluginTx, team: TeamRow): Promise<void> {
  const res = await tx.query<{ ok: boolean }>("SELECT app.can('team', $1, 'manage') AS ok", [team.id]);
  if (res.rows[0]?.ok !== true) throw forbidden('Only a team lead or workspace admin can do that');
}

/** An archived team is read-only until it is unarchived. */
export function requireActive(team: TeamRow): void {
  if (team.archived_at) throw conflict('This team is archived; unarchive it first');
}

/** The caller's person id (null for a bot or anonymous caller). */
export async function callerPersonId(tx: PluginTx): Promise<string | null> {
  const res = await tx.query<{ id: string | null }>('SELECT app.person_id() AS id');
  return res.rows[0]?.id ?? null;
}

export async function newId(tx: PluginTx): Promise<string> {
  const res = await tx.query<{ id: string }>('SELECT uuidv7() AS id');
  const id = res.rows[0]?.id;
  if (!id) throw new Error('uuidv7() returned nothing');
  return id;
}

export interface NewTeam {
  name: string;
  slug: string;
  template: TeamTemplate | null;
}

/**
 * Get-or-create on (workspace, slug) with the kernel's one `INSERT ... ON CONFLICT DO SELECT` (`ctx.db.getOneOrCreate`): a
 * repeat returns the existing team and writes nothing. When the team is new (its pre-drawn id came back) the caller becomes
 * `lead`, the template's role tags are defined, and TEAM.md is held in team_pending_files; the caller emits the events.
 */
export async function getOrCreateTeam(tx: PluginTx, db: PluginDb, input: NewTeam): Promise<{ team: TeamRow; created: boolean }> {
  const id = await newId(tx);
  const row = await db.getOneOrCreate<{ id: string }>(tx, {
    table: 'app.teams',
    values: {
      id,
      workspace_id: tx.actor.workspaceId,
      slug: input.slug,
      name: input.name,
      template: input.template?.id ?? null,
      template_definition: input.template ? JSON.stringify(input.template) : null,
    },
    conflict: ['workspace_id', 'slug'],
    returning: ['id'],
  });
  const created = row.id === id;
  if (created) {
    await tx.query(`INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'lead')`, [
      id,
      tx.actor.id,
      tx.actor.workspaceId,
    ]);
    if (input.template) {
      for (const tag of input.template.roleTags) await tx.query('SELECT * FROM app.teams_tag_define($1, $2)', [id, tag]);
      await tx.query('SELECT app.put_team_pending_files($1, $2::jsonb)', [id, JSON.stringify({ 'TEAM.md': input.template.teamMd })]);
    }
  }
  return { team: await teamById(tx, row.id), created };
}
