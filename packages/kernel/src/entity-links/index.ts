import type { EntityResolver, PluginLinks } from '@manythreads/sdk';
import { EntityLinkKind, EntityRef, EntitySummary, EntityType, LinkDirection, type EntityLinkView } from '@manythreads/shared';
import { z } from 'zod';
import { getOneOrCreate } from '../db/get-or-create.ts';
import { toEntityLinkView, type EntityLinkRow } from '../db/mappers/entity-links.ts';
import type { Tx } from '../db/with-actor.ts';

/** The registered resolvers by entity type (the host owns one map; `ctx.links.registerResolver` fills it). */
export type EntityResolvers = Map<EntityType, { plugin: string; resolver: EntityResolver }>;

const Uuid = z.uuid();
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * The entity-link service behind `ctx.links` (P3-04) on the existing `app.entity_links` table. Everything runs in the caller's
 * transaction, so the team-members-only policy (kernel 0011) decides which links exist for the caller.
 */
export function createEntityLinkService(deps: { resolvers: EntityResolvers; plugin?: string }): PluginLinks {
  return {
    async create(txIn, input) {
      const tx = txIn as unknown as Tx;
      const teamId = Uuid.parse(input.teamId);
      const src = EntityRef.parse(input.src);
      const dst = EntityRef.parse(input.dst);
      const kind = EntityLinkKind.parse(input.kind);
      if (src.type === dst.type && src.id === dst.id) throw new RangeError('An entity cannot be linked to itself');
      const id = (await tx.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]?.id ?? '';
      const row = await getOneOrCreate<EntityLinkRow>(tx, {
        table: 'app.entity_links',
        values: { id, team_id: teamId, src_type: src.type, src_id: src.id, dst_type: dst.type, dst_id: dst.id, kind },
        conflict: ['src_type', 'src_id', 'dst_type', 'dst_id', 'kind'],
      });
      return { link: toEntityLinkView(row), created: row.id === id };
    },

    async remove(txIn, input) {
      const tx = txIn as unknown as Tx;
      const src = EntityRef.parse(input.src);
      const dst = EntityRef.parse(input.dst);
      const kind = EntityLinkKind.parse(input.kind);
      const res = await tx.query(
        `DELETE FROM app.entity_links WHERE src_type = $1 AND src_id = $2 AND dst_type = $3 AND dst_id = $4 AND kind = $5`,
        [src.type, src.id, dst.type, dst.id, kind],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async list(txIn, refIn, directionIn = 'both', options = {}) {
      const tx = txIn as unknown as Tx;
      const ref = EntityRef.parse(refIn);
      const direction = LinkDirection.parse(directionIn);
      const kind = options.kind === undefined ? null : EntityLinkKind.parse(options.kind);
      const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(options.limit ?? DEFAULT_LIMIT)));
      // Out uses the unique index (src_type, src_id, ...), in uses entity_links_dst; "both" is a BitmapOr of the two.
      const where =
        direction === 'out'
          ? '(src_type = $1 AND src_id = $2)'
          : direction === 'in'
            ? '(dst_type = $1 AND dst_id = $2)'
            : '((src_type = $1 AND src_id = $2) OR (dst_type = $1 AND dst_id = $2))';
      const res = await tx.query<EntityLinkRow>(
        `SELECT id, team_id, src_type, src_id, dst_type, dst_id, kind, created_at FROM app.entity_links
         WHERE ${where} AND ($3::text IS NULL OR kind = $3) ORDER BY id DESC LIMIT $4`,
        [ref.type, ref.id, kind, limit],
      );
      return res.rows.map(toEntityLinkView);
    },

    async resolve(txIn, refIn) {
      const ref = EntityRef.parse(refIn);
      const registered = deps.resolvers.get(ref.type);
      if (!registered) return null;
      const found = await registered.resolver(txIn, ref.id);
      if (!found) return null;
      return EntitySummary.parse({ type: ref.type, id: ref.id, title: found.title, subtitle: found.subtitle ?? null, href: found.href ?? null });
    },

    registerResolver(typeIn, resolver) {
      const type = EntityType.parse(typeIn);
      const existing = deps.resolvers.get(type);
      if (existing) {
        throw new Error(`The resolver for "${type}" entities is already registered by plugin "${existing.plugin}"`);
      }
      deps.resolvers.set(type, { plugin: deps.plugin ?? 'unknown', resolver });
    },
  };
}

export type { EntityLinkView };
