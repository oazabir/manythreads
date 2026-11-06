import { AUDIT_ACTIONS, auditActionLabel, type AuditCategory, type AuditEntry, type AuditOutcome, type ExportAuditRequest, type ListAuditQuery } from '@manythreads/shared';

// Words and request-building for the Audit screen. No React here, so it is unit tested.

export interface AuditFilters {
  actor: string;
  category: '' | AuditCategory;
  action: string;
  team: string;
  outcome: '' | AuditOutcome;
  /** `YYYY-MM-DD` as a date input gives it, in the viewer's own day; empty for no bound. */
  from: string;
  to: string;
}

export const NO_FILTERS: AuditFilters = { actor: '', category: '', action: '', team: '', outcome: '', from: '', to: '' };

export const CATEGORY_LABELS: Record<AuditCategory, string> = {
  sign_in: 'Sign-in',
  people: 'People and teams',
  content: 'Content',
  bots: 'Bots',
  approvals: 'Approvals',
  guardrails: 'Guardrails',
  memory: 'Memory',
  access: 'Access',
  settings: 'Settings',
  system: 'System',
};

export const OUTCOME_LABELS: Record<AuditOutcome, string> = { ok: 'Done', denied: 'Refused', failed: 'Failed', withheld: 'Withheld' };

/**
 * A calendar day (plus `plusDays`) as the viewer lives it, as an instant; undefined when it is not a day the server takes (a year before 0001 or
 * after 9999, which a date input lets a person type, or a day that does not exist). `new Date(99, ...)` would mean 1999, so the year is set apart.
 */
function dayInstant(day: string, plusDays: number): string | undefined {
  const m = /^(\d{4,6})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return undefined;
  const year = Number(m[1]);
  const d = new Date(2000, Number(m[2]) - 1, Number(m[3]) + plusDays);
  d.setFullYear(year + (d.getFullYear() - 2000));
  if (Number.isNaN(d.getTime()) || year < 1) return undefined;
  const iso = d.toISOString();
  return /^\d{4}-/.test(iso) && !iso.startsWith('0000') ? iso : undefined;
}

/** The start of a calendar day as the viewer lives it, as an instant. */
export const startOfDay = (day: string): string | undefined => dayInstant(day, 0);

/** The start of the day after `day`: the "to" bound is exclusive, so choosing a last day includes all of it. */
export const startOfNextDay = (day: string): string | undefined => dayInstant(day, 1);

/** The filters as the API's query (only what is set). */
export function toQuery(f: AuditFilters): Partial<ListAuditQuery> {
  const q: Partial<ListAuditQuery> = {};
  if (f.actor) q.actor = f.actor;
  if (f.category) q.category = f.category;
  if (f.action) q.action = f.action;
  if (f.team) q.team = f.team;
  if (f.outcome) q.outcome = f.outcome;
  const from = startOfDay(f.from);
  const to = startOfNextDay(f.to);
  if (from) q.from = from;
  if (to) q.to = to;
  return q;
}

export function toExportRequest(f: AuditFilters): ExportAuditRequest {
  const rest: Record<string, unknown> = { ...toQuery(f) };
  delete rest['limit'];
  delete rest['cursor'];
  return rest as ExportAuditRequest;
}

/** The actions a category holds, in the order of the catalog, for the Action select. */
export function actionsIn(category: '' | AuditCategory): Array<{ value: string; label: string }> {
  return Object.entries(AUDIT_ACTIONS)
    .filter(([, a]) => category === '' || a.category === category)
    .map(([value, a]) => ({ value, label: a.label }));
}

export const actionWords = (e: Pick<AuditEntry, 'action'>): string => auditActionLabel(e.action);

/** "proposal TEAM.md", "person Nadia"; "-" when the row has no target. */
export function targetWords(e: Pick<AuditEntry, 'target'>): string {
  const { kind, label } = e.target;
  if (!kind) return '—';
  const noun = kind.replace(/_/g, ' ');
  return label ? `${noun}: ${label}` : noun;
}

export const outcomeWord = (o: AuditOutcome): string => OUTCOME_LABELS[o];

/** The file name for a download, from the day it was made. */
export const exportFileName = (now: Date): string => `manythreads-audit-${now.toISOString().slice(0, 10)}.ndjson`;

/** The shell commands that check a downloaded export, shown beside the Export button. */
export function verifyCommands(file: string): string[] {
  return [`base64 -d < ${file}.sig > ${file}.sig.bin`, `openssl pkeyutl -verify -pubin -inkey audit-key.pem -rawin -in ${file} -sigfile ${file}.sig.bin`];
}

// ---- folding: a run of the same thing by the same person ("Omar signed in ×7")

/** Consecutive rows with the same actor, action and outcome fold when each is within this long of the one before it. */
export const FOLD_WINDOW_MS = 10 * 60_000;

export interface AuditGroup {
  /** The id of the newest row, which stays the same as older rows are loaded after it. */
  key: string;
  /** Newest first, as the server sends them; one row when nothing folded into it. */
  rows: AuditEntry[];
}

const actorKey = (e: Pick<AuditEntry, 'actor'>): string => `${e.actor.kind}|${e.actor.id ?? ''}|${e.actor.id ? '' : e.actor.name}`;

/**
 * Folds the rows (newest first) into groups: neighbours with the same actor, action and outcome, each within `windowMs` of the one next to it, make
 * one group. Rows that differ in anything else stay apart, and the order is never changed.
 */
export function foldAudit(rows: readonly AuditEntry[], windowMs: number = FOLD_WINDOW_MS): AuditGroup[] {
  const groups: AuditGroup[] = [];
  for (const row of rows) {
    const g = groups[groups.length - 1];
    const prev = g?.rows[g.rows.length - 1];
    if (g && prev && actorKey(prev) === actorKey(row) && prev.action === row.action && prev.outcome === row.outcome && Math.abs(Date.parse(prev.occurredAt) - Date.parse(row.occurredAt)) <= windowMs) {
      g.rows.push(row);
    } else {
      groups.push({ key: row.id, rows: [row] });
    }
  }
  return groups;
}

/** An action's label as the middle of a sentence: "Signed in" becomes "signed in"; a label that opens with a name or acronym is left alone. */
const sentenceCase = (label: string): string => (/^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label);

/** "Omar signed in ×7" for a folded group, the plain sentence for a single row. */
export function foldLabel(g: AuditGroup): string {
  const first = g.rows[0]!;
  const base = `${first.actor.name} ${sentenceCase(actionWords(first))}`;
  return g.rows.length > 1 ? `${base} ×${g.rows.length}` : base;
}

/** What a group was done to: the one thing when all the rows agree, else how many different things. */
export function foldTarget(g: AuditGroup): string {
  const words = new Set(g.rows.map(targetWords));
  return words.size === 1 ? [...words][0]! : `${words.size} different things`;
}

export interface ActorChip {
  id: string;
  name: string;
}

/** The people who appear most in these rows, most first (a tie keeps the order of first appearance), for the Who chips. Bots and the system are not chips. */
export function topActors(rows: readonly AuditEntry[], limit = 5): ActorChip[] {
  const seen = new Map<string, { name: string; n: number }>();
  for (const r of rows) {
    if (r.actor.kind !== 'person' || !r.actor.id) continue;
    const have = seen.get(r.actor.id);
    if (have) have.n += 1;
    else seen.set(r.actor.id, { name: r.actor.name, n: 1 });
  }
  return [...seen.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, limit)
    .map(([id, v]) => ({ id, name: v.name }));
}
