import { EntityLink, EntityLinkView } from '@manythreads/shared';

export interface EntityLinkRow {
  id: string;
  team_id: string;
  src_type: string;
  src_id: string;
  dst_type: string;
  dst_id: string;
  kind: string;
  created_at: Date;
}

export const toEntityLink = (row: EntityLinkRow): EntityLink =>
  EntityLink.parse({
    id: row.id,
    teamId: row.team_id,
    srcType: row.src_type,
    srcId: row.src_id,
    dstType: row.dst_type,
    dstId: row.dst_id,
    kind: row.kind,
    createdAt: row.created_at.toISOString(),
  });

/** The service shape: `src` and `dst` as refs. */
export const toEntityLinkView = (row: EntityLinkRow): EntityLinkView =>
  EntityLinkView.parse({
    id: row.id,
    teamId: row.team_id,
    src: { type: row.src_type, id: row.src_id },
    dst: { type: row.dst_type, id: row.dst_id },
    kind: row.kind,
    createdAt: row.created_at.toISOString(),
  });
