import { InboxItem, type InboxKind } from '@manythreads/shared';

// An inbox item as the database holds it, and as a client reads it.

export interface ItemRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  team_id: string;
  parent_id: string | null;
  origin: string;
  state: string;
  stage: string;
  kind: string;
  name: string;
  size: string | number;
  sha256: string;
  blob_key: string | null;
  files_id: string | null;
  dropper_id: string | null;
  dropper_name: string | null;
  team_only: boolean;
  reason: string | null;
  hold_reason: string | null;
  duplicate_of: string | null;
  source_channel_id: string | null;
  source_message_id: string | null;
  sender: string | null;
  sender_check: string | null;
  filed_paths: string[];
  commit_sha: string | null;
  attempts: number;
  failed_stage: string | null;
  not_before: Date | null;
  released_by: string | null;
  released_at: Date | null;
  drop_run_id: string | null;
  original_removed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  filed_at: Date | null;
}

export const ITEM_COLUMNS = 'i.*';

export function toItem(r: ItemRow): InboxItem {
  return InboxItem.parse({
    id: r.id,
    teamId: r.team_id,
    origin: r.origin,
    state: r.state,
    kind: r.kind,
    name: r.name,
    size: Number(r.size),
    sha256: r.sha256,
    droppedBy: r.dropper_id,
    droppedByName: r.dropper_name,
    teamOnly: r.team_only,
    reason: r.reason,
    holdReason: r.hold_reason,
    duplicateOf: r.duplicate_of,
    parentId: r.parent_id,
    sender: r.sender,
    senderCheck: r.sender_check,
    filedPaths: r.filed_paths,
    commitSha: r.commit_sha,
    originalKept: r.blob_key !== null,
    attempts: r.attempts,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    filedAt: r.filed_at ? r.filed_at.toISOString() : null,
  });
}

/** The kinds the extractors can read into text. The others are stored and told plainly why they cannot be read yet. */
export const READABLE_KINDS: ReadonlySet<InboxKind> = new Set<InboxKind>(['markdown', 'text', 'csv', 'pdf', 'docx', 'pptx', 'xlsx', 'eml', 'html', 'link']);
