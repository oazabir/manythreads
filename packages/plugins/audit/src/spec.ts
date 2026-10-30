import type { AuditOutcome, KnownAuditAction } from '@manythreads/shared';

// What each event type becomes in the audit console (PLAN P10-05). Every mapping below reads only the fields it names and builds its words from
// fixed phrases, ids, numbers and enum values. It never copies a field that can hold something a person wrote or a secret: a message, a file's name or
// contents, a commit subject, an approval's `detail`, a bot definition's error message, a command line, an email address, an IP address, a URL.
// A test (test/spec.test.ts) feeds each mapping a canary in every such field and checks it does not come out.

/** Who did it, as a pointer the projector resolves to a name: a person's id, a bot's id, an actor id (either), or the system itself. */
export type Who = { person: string } | { bot: string } | { actor: string } | 'system';

/** What it was done to. `named` asks the projector to look the name up (a person, a bot, a team or a channel); otherwise `label` is used as given. */
export interface Target {
  kind: string;
  id: string | null;
  label?: string | null;
  named?: 'person' | 'bot' | 'team' | 'channel';
}

/** One event, mapped. `who` and `teamId` left out mean "the actor and team of the event row". */
export interface Mapped {
  action: KnownAuditAction;
  who?: Who;
  teamId?: string | null;
  target?: Target;
  outcome?: AuditOutcome;
  reason?: string | null;
}

type Fields = Readonly<Record<string, unknown>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[a-z0-9_.:-]{1,80}$/i;

const uuid = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
/** A value that is a short identifier (a capability name, a rule name, a host) and nothing else; anything else is dropped. */
const code = (v: unknown): string | null => (typeof v === 'string' && CODE.test(v) ? v : null);
const words = (v: unknown): string | null => (typeof v === 'string' && /^[a-z_]{1,40}$/.test(v) ? v.replace(/_/g, ' ') : null);
/** Cuts a text to `n` UTF-16 units with an ellipsis, never between the two halves of a character outside the basic plane (a lone half cannot be stored as JSON). */
export const clip = (s: string, n = 200): string => {
  if (s.length <= n) return s;
  let end = n - 1;
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${s.slice(0, end)}…`;
};
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const sentence = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const person = (v: unknown): Who | undefined => {
  const id = uuid(v);
  return id ? { person: id } : undefined;
};
const actor = (v: unknown): Who | undefined => {
  const id = uuid(v);
  return id ? { actor: id } : undefined;
};
const bot = (v: unknown): Who => {
  const id = uuid(v);
  return id ? { bot: id } : 'system';
};
const of = (kind: string, id: unknown, label?: string | null, named?: Target['named']): Target => {
  const t: Target = { kind, id: typeof id === 'string' && id.length > 0 && id.length <= 80 ? id : null, label: label ?? null };
  if (named) t.named = named;
  return t;
};
const team = (v: unknown): string | null => uuid(v);

const GUARDED_ROOTS = /^(TEAM\.md|(bots|skills|routines)(\/[A-Za-z0-9._-]{1,80}){0,4})$/;
/**
 * The label of a repo path. A path can name something private (`memory/people/jane.md`, `channels/<id>/salary.pdf`), so only the guarded places a
 * proposal may change (`TEAM.md`, `bots/`, `skills/`, `routines/`: a bot's, skill's or routine's own name) are shown whole, and only when every part is a
 * plain file name; any other path shows its top folder and nothing more, and a bare file name shows nothing.
 */
export const pathLabel = (v: unknown): string | null => {
  if (typeof v !== 'string' || v.length === 0) return null;
  if (GUARDED_ROOTS.test(v)) return clip(v, 120);
  const top = v.split('/')[0] ?? '';
  return v.includes('/') && /^[a-z_]{1,20}$/.test(top) ? top : null;
};

const LLM_OUTCOME: Record<string, string> = { redact: 'Redacted', require_approval: 'Held for approval', block: 'Blocked' };
const GATE_STAGE: Record<string, string> = {
  exact: 'Held: matches a listed command',
  regex: 'Held: matches a command pattern',
  classifier: 'Held: judged risky',
  classifier_unavailable: 'Held: the risk check was unavailable',
};
const SIGN_IN_FAILED: Record<string, string> = {
  wrong_password: 'Wrong password',
  locked: 'Account locked after too many tries',
  suspended: 'Account suspended',
  method_disabled: 'Password sign-in is switched off',
};
const BUDGET_REFUSAL: Record<string, string> = {
  budget: 'Spending limit reached',
  rate: 'Too many requests a minute',
  preset: 'Blocked by the guard preset',
  dlp: 'Blocked by the data-loss check',
};
const APPROVAL_SOURCE: Record<string, string> = {
  environment: 'Asked by the environment rules',
  dispatch: 'Asked by a command rule',
  dlp: 'Asked by the data-loss check',
  grant: 'Asked by a capability grant',
};

/** The rules that fired, as a short list of identifiers. */
const ruleList = (rules: unknown): string => {
  const list = Array.isArray(rules) ? rules.map(code).filter((r): r is string => r !== null) : [];
  return list.length === 0 ? '' : `: ${clip([...new Set(list)].slice(0, 6).join(', '), 120)}`;
};

const changedParts = (e: Fields): string | null => {
  const parts = [e['baseUrlChanged'] === true ? 'address' : '', e['keyChanged'] === true ? 'key' : ''].filter(Boolean);
  return parts.length === 0 ? null : `Changed: ${parts.join(' and ')}`;
};

type Mapper = (e: Fields) => Mapped | null;

/** The mapping of every event type the console shows, by event type. An event type not listed here is not audited. */
export const MAPPERS: Readonly<Record<string, Mapper>> = {
  'identity.session.signed_in': (e) => ({
    action: 'sign_in.succeeded',
    who: person(e['personId']),
    target: of('person', uuid(e['personId']), null, 'person'),
    reason: e['method'] === 'bootstrap' ? 'First sign-in after setup' : 'With a password',
  }),
  'identity.session.sign_in_failed': (e) => ({
    action: 'sign_in.failed',
    who: person(e['personId']),
    target: of('person', uuid(e['personId']), null, 'person'),
    outcome: 'denied',
    reason: SIGN_IN_FAILED[String(e['reason'])] ?? 'Refused',
  }),
  'identity.session.signed_out': (e) => ({
    action: 'sign_in.signed_out',
    who: person(e['personId']),
    target: of('person', uuid(e['personId']), null, 'person'),
    reason: e['scope'] === 'everywhere' ? `Ended every session (${num(e['revoked'])})` : e['scope'] === 'other_session' ? 'Ended another session' : 'Ended this session',
  }),
  'identity.oidc.signed_in': (e) => ({
    action: 'sign_in.single_sign_on',
    who: person(e['personId']),
    target: of('provider', uuid(e['providerId']), words(e['kind'])),
    reason: e['createdPerson'] === true ? 'Account created on first sign-in' : null,
  }),
  'identity.oidc.refused': (e) => {
    const why = words(e['reason']);
    return { action: 'sign_in.single_sign_on_refused', who: 'system', target: of('provider', uuid(e['providerId']), words(e['kind'])), outcome: 'denied', reason: why ? sentence(why) : 'Refused' };
  },
  'identity.password.changed': (e) => ({
    action: 'password.changed',
    who: person(e['personId']),
    target: of('person', uuid(e['personId']), null, 'person'),
    reason: num(e['revokedSessions']) > 0 ? `Ended ${plural(num(e['revokedSessions']), 'other session')}` : null,
  }),
  'identity.password.reset': (e) => ({ action: 'password.reset', who: person(e['personId']), target: of('person', uuid(e['personId']), null, 'person') }),
  'identity.password.admin_set': (e) => ({
    action: 'password.set_by_admin',
    target: of('person', uuid(e['personId']), null, 'person'),
    reason: num(e['sessionsRevoked']) > 0 ? `Ended ${plural(num(e['sessionsRevoked']), 'session')}` : null,
  }),
  'identity.provider.changed': (e) => ({
    action: 'sign_in_method.changed',
    who: person(e['personId']),
    target: of('provider', uuid(e['providerId']), words(e['kind'])),
    reason: words(e['change']) ? sentence(String(words(e['change']))) : null,
  }),
  'identity.workspace.bootstrapped': (e) => ({
    action: 'sign_in.workspace_created',
    who: person(e['personId']),
    target: of('workspace', null, typeof e['workspaceName'] === 'string' ? clip(e['workspaceName']) : null),
  }),
  'workspace.member.role_changed': (e) => ({
    action: 'member.role_changed',
    who: person(e['changedBy']),
    target: of('person', uuid(e['personId']), null, 'person'),
    reason: `From ${words(e['previousRole']) ?? 'unknown'} to ${words(e['role']) ?? 'unknown'}`,
  }),
  'workspace.invitation.created': (e) => ({
    action: 'invitation.created',
    teamId: team(e['teamId']),
    target: of('invitation', uuid(e['invitationId'])),
    reason: `As ${words(e['role']) ?? 'a member'}`,
  }),
  'workspace.invitation.accepted': (e) => ({
    action: 'invitation.accepted',
    who: person(e['personId']),
    teamId: team(e['teamId']),
    target: of('invitation', uuid(e['invitationId'])),
    reason: e['createdPerson'] === true ? 'New account' : null,
  }),
  'workspace.team.created': (e) => ({
    action: 'team.created',
    teamId: team(e['teamId']),
    target: of('team', uuid(e['teamId']), typeof e['name'] === 'string' ? clip(e['name']) : null, 'team'),
    reason: typeof e['template'] === 'string' && code(e['template']) ? `From the ${e['template']} template` : null,
  }),
  'workspace.team.renamed': (e) => ({
    action: 'team.renamed',
    teamId: team(e['teamId']),
    target: of('team', uuid(e['teamId']), typeof e['name'] === 'string' ? clip(e['name']) : null, 'team'),
    reason: typeof e['previousName'] === 'string' ? clip(`Was ${e['previousName']}`) : null,
  }),
  'workspace.team.archived': (e) => ({ action: 'team.archived', teamId: team(e['teamId']), target: of('team', uuid(e['teamId']), null, 'team') }),
  'workspace.team.unarchived': (e) => ({ action: 'team.unarchived', teamId: team(e['teamId']), target: of('team', uuid(e['teamId']), null, 'team') }),
  'team.member.added': (e) => ({
    action: 'team.member_added',
    teamId: team(e['teamId']),
    target: of('person', uuid(e['personId']), null, 'person'),
    reason: `As ${words(e['role']) ?? 'a member'}`,
  }),
  'team.member.removed': (e) => ({
    action: 'team.member_removed',
    teamId: team(e['teamId']),
    target: of('person', uuid(e['personId']), null, 'person'),
    reason: `Was ${words(e['role']) ?? 'a member'}`,
  }),
  'team.role.changed': (e) => ({
    action: 'team.role_changed',
    teamId: team(e['teamId']),
    target: of('person', uuid(e['personId']), null, 'person'),
    reason: `From ${words(e['previousRole']) ?? 'unknown'} to ${words(e['role']) ?? 'unknown'}`,
  }),
  'workspace.settings.updated': (e) => {
    const changes = e['changes'] && typeof e['changes'] === 'object' ? Object.keys(e['changes'] as object) : [];
    const known = changes.filter((k) => ['name', 'selfSignup', 'passwordForMembers'].includes(k)).map((k) => (k === 'name' ? 'name' : k === 'selfSignup' ? 'self sign-up' : 'passwords for members'));
    return { action: 'workspace.settings_updated', who: person(e['personId']), target: of('workspace', null), reason: known.length > 0 ? `Changed: ${known.join(', ')}` : null };
  },
  'proposals.proposal.created': (e) => ({
    action: 'proposal.created',
    who: actor(e['authorId']),
    teamId: team(e['teamId']),
    target: of('proposal', uuid(e['proposalId']), pathLabel(e['path'])),
    reason: `${e['op'] === 'delete' ? 'Removal' : 'Edit'}${e['checksOk'] === false ? ', its checks failed' : ''}`,
  }),
  'proposals.proposal.applied': (e) => ({
    action: 'proposal.applied',
    who: actor(e['actorId']),
    teamId: team(e['teamId']),
    target: of('proposal', uuid(e['proposalId']), pathLabel(e['path'])),
    reason: e['selfApplied'] === true ? 'Applied by its own author' : 'Applied by a reviewer',
  }),
  'proposals.proposal.rejected': (e) => ({
    action: 'proposal.rejected',
    who: actor(e['actorId']),
    teamId: team(e['teamId']),
    target: of('proposal', uuid(e['proposalId']), pathLabel(e['path'])),
    outcome: e['reason'] === 'withdrawn' ? 'ok' : 'denied',
    reason: e['reason'] === 'withdrawn' ? 'Withdrawn by its author' : 'Turned down by a reviewer',
  }),
  'files.file.uploaded': (e) => {
    const mime = typeof e['mime'] === 'string' && /^[a-z0-9][\w.+-]{0,60}\/[\w.+-]{1,80}$/i.test(e['mime']) ? e['mime'] : null;
    const kb = Math.max(1, Math.round(num(e['size']) / 1024));
    return { action: 'file.uploaded', who: actor(e['uploaderId']), teamId: team(e['teamId']), target: of('file', uuid(e['fileId'])), reason: `${mime ?? 'File'}, ${kb} KB` };
  },
  'files.file.deleted': (e) => ({ action: 'file.deleted', who: actor(e['deletedBy']), teamId: team(e['teamId']), target: of('file', uuid(e['fileId'])) }),
  'channel.channel.created': (e) =>
    e['kind'] === 'channel'
      ? { action: 'channel.created', teamId: team(e['teamId']), target: of('channel', uuid(e['channelId']), null, 'channel'), reason: e['private'] === true ? 'Private channel' : 'Open channel' }
      : null,
  'channel.channel.archived': (e) => ({
    action: 'channel.archived',
    teamId: team(e['teamId']),
    target: of('channel', uuid(e['channelId']), null, 'channel'),
    reason: e['archived'] === false ? 'Restored' : 'Archived',
  }),
  'channel.member.added': (e) => ({
    action: 'channel.member_added',
    who: e['self'] === true ? person(e['personId']) : undefined,
    teamId: team(e['teamId']),
    target: of('person', uuid(e['personId']), null, 'person'),
    reason: e['self'] === true ? 'Joined by themselves' : null,
  }),
  'channel.member.removed': (e) => ({
    action: 'channel.member_removed',
    who: e['self'] === true ? person(e['personId']) : undefined,
    teamId: team(e['teamId']),
    target: of('person', uuid(e['personId']), null, 'person'),
    reason: e['self'] === true ? 'Left by themselves' : null,
  }),
  'channel.message.deleted': (e) => ({ action: 'message.deleted', who: actor(e['deletedBy']), teamId: team(e['teamId']), target: of('message', uuid(e['messageId'])) }),
  'approvals.approval.requested': (e) => ({
    action: 'approval.requested',
    who: actor(e['requesterId']),
    teamId: team(e['teamId']),
    target: of('approval', uuid(e['approvalId']), code(e['tool'])),
    reason: APPROVAL_SOURCE[String(e['source'])] ?? null,
  }),
  'approvals.approval.decided': (e) => ({
    action: 'approval.decided',
    who: actor(e['deciderId']),
    teamId: team(e['teamId']),
    target: of('approval', uuid(e['approvalId']), code(e['tool'])),
    outcome: e['decision'] === 'denied' ? 'denied' : 'ok',
    reason: e['decision'] === 'denied' ? 'Denied' : 'Approved',
  }),
  'approvals.approval.resumed': (e) => ({
    action: 'approval.resumed',
    who: bot(e['botId']),
    teamId: team(e['teamId']),
    target: of('approval', uuid(e['approvalId']), code(e['tool'])),
    outcome: e['outcome'] === 'failed' ? 'failed' : 'ok',
    reason: e['outcome'] === 'failed' ? 'Failed after it was approved' : 'Ran after it was approved',
  }),
  'bots.bot.loaded': (e) => ({ action: 'bot.loaded', teamId: team(e['teamId']), target: of('bot', uuid(e['botId']), code(e['slug']), 'bot') }),
  'bots.bot.removed': (e) => ({ action: 'bot.removed', teamId: team(e['teamId']), target: of('bot', uuid(e['botId']), code(e['slug'])) }),
  'bots.pairing.rotated': (e) => ({
    action: 'bot.pairing_rotated',
    who: actor(e['actorId']),
    teamId: team(e['teamId']),
    target: of('bot', uuid(e['botId']), null, 'bot'),
    reason: `Ended ${plural(num(e['revoked']), 'pairing')}`,
  }),
  'llm.key.changed': (e) => ({
    action: 'bot.key_changed',
    target: of('bot', uuid(e['botId']), null, 'bot'),
    reason: e['action'] === 'revoked' ? 'Key revoked' : e['action'] === 'updated' ? 'Key replaced' : 'Key created',
  }),
  'runners.token.minted': (e) => ({ action: 'runner.token_minted', who: actor(e['actorId']), teamId: team(e['teamId']), target: of('runner', uuid(e['runnerId'])) }),
  'runners.token.revoked': (e) => ({
    action: 'runner.token_revoked',
    who: actor(e['actorId']),
    teamId: team(e['teamId']),
    target: of('runner', uuid(e['runnerId'])),
    reason: `Ended ${plural(num(e['revoked']), 'connection')}`,
  }),
  'hermes.connection.created': (e) => ({
    action: 'hermes.connection_created',
    who: actor(e['actorId']),
    teamId: team(e['teamId']),
    target: of('connection', uuid(e['connectionId']), typeof e['name'] === 'string' ? clip(e['name']) : null),
  }),
  'hermes.connection.updated': (e) => ({
    action: 'hermes.connection_updated',
    who: actor(e['actorId']),
    teamId: team(e['teamId']),
    target: of('connection', uuid(e['connectionId']), typeof e['name'] === 'string' ? clip(e['name']) : null),
    reason: changedParts(e),
  }),
  'hermes.connection.deleted': (e) => ({
    action: 'hermes.connection_deleted',
    who: actor(e['actorId']),
    teamId: team(e['teamId']),
    target: of('connection', uuid(e['connectionId']), typeof e['name'] === 'string' ? clip(e['name']) : null),
  }),
  'webhooks.hook.created': (e) => ({ action: 'webhook.created', who: actor(e['actorId']), teamId: team(e['teamId']), target: of('webhook', uuid(e['webhookId'])) }),
  'webhooks.hook.revoked': (e) => ({ action: 'webhook.revoked', who: actor(e['actorId']), teamId: team(e['teamId']), target: of('webhook', uuid(e['webhookId'])) }),
  'webhooks.hook.rotated': (e) => ({ action: 'webhook.rotated', who: actor(e['actorId']), teamId: team(e['teamId']), target: of('webhook', uuid(e['webhookId'])) }),
  'webhooks.hook.signing_changed': (e) => ({
    action: 'webhook.signing_changed',
    who: actor(e['actorId']),
    teamId: team(e['teamId']),
    target: of('webhook', uuid(e['webhookId'])),
    reason: e['enabled'] === true ? 'Signing switched on' : 'Signing switched off',
  }),
  'kernel.capability.denied': (e) => {
    const cap = code(e['capability']);
    const kind = e['actorKind'];
    const id = uuid(e['actorId']);
    return {
      action: 'capability.denied',
      who: id && kind === 'bot' ? { bot: id } : id && kind === 'person' ? { actor: id } : 'system',
      target: of('capability', cap, pathLabel(e['path'])),
      outcome: 'denied',
      reason: code(e['reason']) ? sentence(String(e['reason']).replace(/[_:]/g, ' ')) : 'Refused',
    };
  },
  'guardrails.dlp.decided': (e) => ({
    action: 'guard.dlp_decided',
    who: bot(e['botId']),
    teamId: team(e['teamId']),
    target: of('destination', code(e['destination'])),
    outcome: 'withheld',
    reason: `${LLM_OUTCOME[String(e['outcome'])] ?? 'Held'} by the data-loss check${ruleList(e['rules'])}`,
  }),
  'guardrails.egress.decided': (e) => {
    const host = typeof e['host'] === 'string' && /^[a-z0-9.-]{1,80}$/i.test(e['host']) ? e['host'] : null;
    return { action: 'guard.egress_blocked', who: bot(e['botId']), teamId: team(e['teamId']), target: of('host', host), outcome: 'denied', reason: 'Blocked by the outgoing-request policy' };
  },
  'guardrails.policy.updated': (e) => ({
    action: 'guard.policy_changed',
    who: actor(e['changedBy']),
    teamId: team(e['teamId']),
    target: of(e['kind'] === 'egress' ? 'egress_policy' : 'dlp_policy', code(e['subject'])),
    reason: `${words(e['change']) ?? 'changed'}${e['kind'] === 'egress' ? ' (reachable hosts)' : ' (data-loss check)'}`,
  }),
  'llm.guard.decided': (e) =>
    e['outcome'] === 'allow'
      ? null
      : {
          action: 'guard.model_decided',
          who: bot(e['botId']),
          target: of('model_alias', code(e['alias'])),
          outcome: 'withheld',
          reason: `${LLM_OUTCOME[String(e['outcome'])] ?? 'Held'} by the model guard${ruleList(e['rules'])}`,
        },
  'llm.budget.exceeded': (e) => ({
    action: 'guard.budget_refused',
    who: bot(e['botId']),
    teamId: team(e['teamId']),
    target: of('model_alias', code(e['alias'])),
    outcome: 'denied',
    reason: `${BUDGET_REFUSAL[String(e['reason'])] ?? 'Refused'}${words(e['scope']) ? ` (${words(e['scope'])} limit)` : ''}`,
  }),
  'runtime.gate.held': (e) => ({
    action: 'guard.gate_held',
    who: bot(e['botId']),
    teamId: team(e['teamId']),
    target: of('approval', uuid(e['approvalId'])),
    outcome: 'withheld',
    reason: GATE_STAGE[String(e['stage'])] ?? 'Held',
  }),
  'answer.answer.posted': (e) => {
    const dropped = num(e['droppedCount']);
    if (dropped === 0) return null;
    return {
      action: 'answer.sources_held_back',
      who: person(e['askerPersonId']) ?? bot(e['botId']),
      target: of('bot', uuid(e['botId']), null, 'bot'),
      outcome: 'withheld',
      reason: `${plural(dropped, 'source')} held back, ${num(e['citationCount'])} shown`,
    };
  },
  'answer.answer.shared': (e) => {
    const masked = num(e['maskedCount']);
    const removed = num(e['removedCount']);
    return {
      action: 'answer.shared',
      who: person(e['personId']),
      target: of('bot', uuid(e['botId']), null, 'bot'),
      outcome: masked + removed > 0 ? 'withheld' : 'ok',
      reason: `Shared to a ${words(e['kind']) ?? 'place'}: ${num(e['keptCount'])} kept, ${masked} masked, ${removed} removed`,
    };
  },
  'llm.config.applied': (e) => ({
    action: 'model_config.applied',
    target: of('model_config', null),
    reason: `${plural(num(e['providers']), 'provider')}, ${plural(num(e['aliases']), 'alias', 'aliases')}`,
  }),
  'retention.settings.changed': (e) => {
    const win = (v: unknown): string => {
      const o = v && typeof v === 'object' ? (v as Fields) : {};
      return `${num(o['from'])} to ${num(o['to'])} days`;
    };
    return { action: 'retention.settings_changed', who: actor(e['changedBy']), target: of('retention', null), reason: `Run logs ${win(e['runLogDays'])}; memory log ${win(e['memoryLogDays'])}` };
  },
  'retention.sweep.completed': (e) => ({
    action: 'retention.sweep_completed',
    who: 'system',
    target: of('retention', uuid(e['sweepId'])),
    reason: e['dryRun'] === true ? 'Preview only, nothing deleted' : 'Old logs deleted',
  }),
  'audit.export.created': (e) => ({
    action: 'audit.exported',
    who: actor(e['exportedBy']),
    target: of('audit_export', code(e['keyId'])),
    reason: `${plural(num(e['rowCount']), 'row')}${e['truncated'] === true ? ', cut short at the row limit' : ''}`,
  }),
};

/** Every event type the console shows. */
export const AUDITED_EVENT_TYPES: readonly string[] = Object.keys(MAPPERS);

/** A memory retain-log reason is a fixed code (`private_source`, `run_open`); anything else becomes a generic phrase. */
export function memoryReason(reasonCode: unknown): string {
  const w = words(reasonCode);
  return w ? sentence(w) : 'Not kept';
}

/** The safe form of a memory log's source kind and id for a target. */
export function memoryTarget(sourceKind: unknown, sourceId: unknown): Target {
  const kind = typeof sourceKind === 'string' && /^[a-z_]{1,40}$/.test(sourceKind) ? sourceKind : 'source';
  const id = typeof sourceId === 'string' && sourceId.length > 0 && sourceId.length <= 80 && CODE.test(sourceId) ? sourceId : null;
  return { kind, id, label: null };
}
