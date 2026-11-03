import { BOT_SLUG_RE, LlmGuardPreset, botSlugProblem, type BotFrontmatter, type SetupInventory } from '@manythreads/shared';
import { parse as parseYaml } from 'yaml';
import { UNREADABLE_DEFAULTS_MESSAGE, presetAllowed, readTeamDefaults } from './team-defaults.ts';

// What `propose_config` refuses (PLAN P7-03). The rule is one sentence: a bot set up this way is never given more than the team's defaults allow and never more than the person asking
// may give. Everything here is plain code over the parsed BOT.md and the inventory; the model cannot argue with it, and each refusal says in words what to change so the helper can try
// again. A refusal files nothing. (That the BOT.md parses, and that its runner may be used, is checked by the same functions the bot loader uses; see tools.ts.)

export interface Refusal {
  /** The part of the file the refusal is about, e.g. `capabilities.native`. */
  field: string;
  message: string;
}

export interface PolicyInput {
  slug: string;
  frontmatter: BotFrontmatter;
  inventory: SetupInventory;
  /** Skill slugs the same proposal creates. */
  newSkills: readonly string[];
  /** The team's slug, for the memory bank a bot may be given. */
  teamSlug: string;
  /** The bot already exists and this is an edit of it (the Workshop's Build mode): its own slug is not a duplicate, and the scenario set (`evals`) is allowed. See `checkBotEdit`. */
  existing?: boolean;
}

const refuse = (field: string, message: string): Refusal => ({ field, message });

/** The triggers a bot made by the setup helper cannot have: they need a connection to another app, which the helper cannot give a bot. */
const CONNECTION_TRIGGERS = new Set(['inbox', 'webhook']);

/** `role:on-call` and `on-call` both name the role tag "on-call". */
const roleOf = (principal: string): string | null => (principal.startsWith('role:') ? principal.slice(5) : null);

export function checkBotProposal(input: PolicyInput): Refusal[] {
  const { slug, frontmatter: fm, inventory: inv } = input;
  const out: Refusal[] = [];
  const mayGrant = inv.asker.canGrantDestructive;

  const slugProblem = BOT_SLUG_RE.test(slug) ? null : botSlugProblem(slug);
  if (slugProblem !== null) out.push(refuse('slug', slugProblem));
  // `new` is the address of the Add a bot page (/t/<team>/bots/new): a bot with that slug could never be opened
  else if (slug === 'new') out.push(refuse('slug', 'A bot cannot be called "new": that is the address of the Add a bot page. Pick another name.'));
  else if (input.existing !== true && inv.bots.some((b) => b.slug === slug)) out.push(refuse('slug', `The team already has a bot called "${slug}". Change it on its own page; pick a new name for a new bot.`));

  if (input.existing !== true && (fm.kind !== 'agent' || fm.runtime !== 'hermes')) {
    out.push(refuse('runtime', 'The setup helper makes agent bots that run on Hermes (kind: agent, runtime: hermes). A rules bot is written by hand.'));
  }

  // Where it runs: only a runner the team may use, by name. The old ways (a gateway, a node, a runner machine) are for hand-written bots.
  const place = fm.placement;
  if (place?.gateway !== undefined || place?.node !== undefined || place?.runner !== undefined) {
    out.push(refuse('placement', 'Name where the bot runs with placement.runs_on (a runner the team may use). The gateway, node and runner keys are not for a bot set up this way.'));
  }
  if (place?.runs_on !== undefined && !inv.runners.some((r) => r.name === place.runs_on)) {
    out.push(refuse('placement.runs_on', `"${place.runs_on}" is not a runner this team may use. The team may use: ${inv.runners.map((r) => r.name).join(', ') || 'none yet'}.`));
  }

  // Tools: each must exist, none by wildcard; one that can change things needs "ask a person first" and a person who may grant it.
  const approvalFor = new Set(fm.approvals?.needsApproval ?? []);
  for (const name of fm.capabilities?.native ?? []) {
    if (name.endsWith('.*')) {
      out.push(refuse('capabilities.native', `"${name}" gives every tool of a group. List the tools the bot needs by name.`));
      continue;
    }
    const tool = inv.capabilities.find((c) => c.name === name);
    if (!tool) {
      out.push(refuse('capabilities.native', `There is no tool called "${name}" on this platform.`));
    } else if (tool.destructive) {
      if (!mayGrant) out.push(refuse('capabilities.native', `"${name}" can change things, and only a team lead or an admin may give it to a bot. Leave it out, or ask a lead to set it up.`));
      if (!approvalFor.has(name)) out.push(refuse('approvals.needsApproval', `"${name}" can change things, so the bot has to ask a person first: add it to approvals.needsApproval.`));
    }
  }
  for (const name of approvalFor) {
    if (!inv.capabilities.some((c) => c.name === name)) out.push(refuse('approvals.needsApproval', `There is no tool called "${name}" on this platform.`));
  }

  // Shell, files, a browser: only what the team allows, and only when the person asking may grant it.
  for (const name of fm.capabilities?.runtime ?? []) {
    if (!inv.runtimeAllowed.includes(name)) out.push(refuse('capabilities.runtime', `This team has not allowed bots to use "${name}". Leave it out.`));
    else if (!mayGrant) out.push(refuse('capabilities.runtime', `This team allows "${name}" for bots, but only a team lead or an admin may grant it.`));
  }
  if ((fm.capabilities?.connections ?? []).length > 0) {
    out.push(refuse('capabilities.connections', 'The setup helper cannot give a bot a connection to another app. Add it on the bot\'s own page.'));
  }

  // What starts it. The router fires `mention` and `channel_message` only in the team's public channels (never a private one, a DM or an archived one) and, left without `source`, in ALL of
  // them: so a `channel_message` trigger must name its channels, and every channel named must be one the asker can see in this team (the inventory lists exactly those).
  const channelNames = new Set(inv.channels.map((c) => c.name.toLowerCase()));
  for (const trigger of fm.triggers ?? []) {
    if (CONNECTION_TRIGGERS.has(trigger.type)) {
      out.push(refuse('triggers', `A "${trigger.type}" trigger needs a connection to another app, and the setup helper cannot give a bot one. Add the connection and the trigger on the bot's own page.`));
    }
    // The team's Archivist is the one bot that starts from a drop into the memory inbox; a second one would compete with it for every dropped item.
    if (trigger.type === 'drop') out.push(refuse('triggers', 'A "drop" trigger belongs to the team\'s Archivist, which files what is dropped into the memory inbox. A bot made here cannot take that over.'));
    if (trigger.type === 'channel_message' && trigger.source === undefined) {
      out.push(refuse('triggers', 'A channel_message trigger without source.channels would answer every message in every channel of the team. Name the channels it should read, like source: { channels: ["#dev"] }.'));
    }
    if (trigger.type === 'channel_message' || trigger.type === 'mention') {
      for (const ref of trigger.source?.channels ?? []) {
        if (!channelNames.has(ref.slice(1).toLowerCase())) {
          out.push(refuse('triggers', `"${ref}" is not a channel of this team that the bot can read. Channels it can read: ${inv.channels.map((c) => `#${c.name}`).join(', ') || 'none'}.`));
        }
      }
    }
  }

  // What it reads and which model it uses.
  for (const entry of fm.knowledge ?? []) {
    if (!inv.knowledge.some((k) => k.slug === entry.base)) out.push(refuse('knowledge', `The team has no knowledge base called "${entry.base}".`));
  }
  for (const skill of fm.skills ?? []) {
    if (!inv.skills.some((s) => s.slug === skill) && !input.newSkills.includes(skill)) out.push(refuse('skills', `The team has no skill called "${skill}". Include its text with the proposal, or leave it out.`));
  }
  if (fm.model?.subscription !== undefined) {
    out.push(refuse('model.subscription', 'A subscription model is chosen by an admin. Use model.aliases.'));
  }
  for (const alias of [...(fm.model?.aliases ?? []), ...(fm.model?.fallbacks ?? [])]) {
    if (!inv.models.some((m) => m.alias === alias)) out.push(refuse('model', `The model "${alias}" is not set up in this workspace. Set up: ${inv.models.map((m) => m.alias).join(', ') || 'none yet'}.`));
  }

  // Who can see it, and what it remembers.
  if (fm.visibility === 'workspace' && inv.asker.role !== 'admin') {
    out.push(refuse('visibility', 'Only a workspace admin may make a bot visible to the whole workspace. Use visibility: team.'));
  }
  for (const grant of fm.memory?.grants ?? []) {
    if (grant.bank !== `team:${input.teamSlug}`) out.push(refuse('memory.grants', `A bot may use only its own team's memory bank (team:${input.teamSlug}).`));
    else if (grant.access === 'readwrite' && !mayGrant) out.push(refuse('memory.grants', 'Only a team lead or an admin may let a bot write to the team memory. Use access: read.'));
  }

  // The guard: never weaker than the team's default.
  const preset = fm.guard?.preset ?? 'standard';
  const known = LlmGuardPreset.safeParse(preset);
  if (!known.success) out.push(refuse('guard.preset', `"${preset}" is not a guard preset. Use one of: ${LlmGuardPreset.options.join(', ')}.`));
  else if (!presetAllowed(inv.guardDefault as LlmGuardPreset, known.data)) {
    out.push(refuse('guard.preset', `This team's default guard is "${inv.guardDefault}". Set guard.preset to "${inv.guardDefault}" (or "air-gapped"); a bot may not be looser than the team's default.`));
  }

  // People it may hand over to: roles the team has, never a named person.
  const roles = new Set(inv.roleTags.map((t) => (t.startsWith('role:') ? t.slice(5) : t)));
  const principals: Array<[string, readonly string[]]> = [
    ['approvals.approvers', fm.approvals?.approvers ?? []],
    ['handover.toPerson', fm.handover?.toPerson ?? []],
    ['handover.escalation.to', fm.handover?.escalation?.to ?? []],
  ];
  for (const [field, list] of principals) {
    for (const principal of list) {
      const role = roleOf(principal);
      if (role === null) out.push(refuse(field, `Name a role of the team (like role:on-call), not a person ("${principal}").`));
      else if (!roles.has(role)) out.push(refuse(field, `The team has no role "${role}".`));
    }
  }
  if (fm.handover?.mayTag !== undefined) {
    for (const tag of fm.handover.mayTag) {
      if (!inv.bots.some((b) => b.slug === tag)) out.push(refuse('handover.mayTag', `The team has no bot called "${tag}" to hand over to.`));
    }
  }

  if (input.existing !== true && fm.evals !== undefined) out.push(refuse('evals', 'An evaluation set is written by hand after the bot exists; leave evals out.'));
  return out;
}

/**
 * What a change to an EXISTING bot's BOT.md is refused for (the Workshop's Build mode, PLAN P7-05). The rule is the same sentence as for a new bot (never more than the team's defaults and
 * the asker allow) with two changes: the bot keeps its kind and runtime (the helper changes what a bot does, not what it is), and a refusal the CURRENT file already earns is not held
 * against the change: only what the change makes worse is refused, so tightening a bot that is looser than today's defaults is always possible and a member can still edit its words.
 */
export function checkBotEdit(input: Omit<PolicyInput, 'frontmatter' | 'existing'> & { current: BotFrontmatter; next: BotFrontmatter }): Refusal[] {
  const { current, next, ...rest } = input;
  const key = (r: Refusal): string => `${r.field}\u0000${r.message}`;
  const before = new Set(checkBotProposal({ ...rest, frontmatter: current, existing: true }).map(key));
  const out = checkBotProposal({ ...rest, frontmatter: next, existing: true }).filter((r) => !before.has(key(r)));
  if (next.kind !== current.kind || next.runtime !== current.runtime) {
    out.push(refuse('runtime', `The helper cannot change what kind of bot this is (it is ${current.kind}/${current.runtime}). Keep kind and runtime as they are.`));
  }
  // taking away a "ask a person first" is loosening a gate: only a lead or an admin may propose it
  const nextApprovals = new Set(next.approvals?.needsApproval ?? []);
  const removed = (current.approvals?.needsApproval ?? []).filter((t) => !nextApprovals.has(t));
  if (removed.length > 0 && !input.inventory.asker.canGrantDestructive) {
    out.push(refuse('approvals.needsApproval', `Only a team lead or an admin may let a bot use ${removed.map((t) => `"${t}"`).join(', ')} without asking a person first. Keep it in approvals.needsApproval.`));
  }
  return out;
}

/** What may change in a skill proposed with a bot. */
export function checkSkill(slug: string, text: string, inv: SetupInventory): Refusal[] {
  const out: Refusal[] = [];
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) out.push(refuse(`skills.${slug}`, 'A skill name is lower case letters, digits and "-", at most 63 characters.'));
  else if (inv.skills.some((s) => s.slug === slug)) out.push(refuse(`skills.${slug}`, `The team already has a skill called "${slug}". Change it on its own page.`));
  if (text.trim() === '') out.push(refuse(`skills.${slug}`, 'A skill needs some text.'));
  return out;
}

/** The text of a frontmatter block of TEAM.md as a mapping, or null. */
function teamFrontmatter(text: string): Record<string, unknown> | null {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return null;
  try {
    const doc: unknown = parseYaml(m[1] as string, { maxAliasCount: 20 });
    return typeof doc === 'object' && doc !== null && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * A change to TEAM.md that comes with a bot (a role the bot hands over to, a channel group, a line in the notes). It must still be a team file, must come from a lead or an admin, and may
 * not touch the keys that say what bots may be given (`defaults.botRuntime`, `defaults.guardPreset`): those are the team's decision, not something a bot's setup can loosen.
 */
export function checkTeamMdChange(current: string | null, proposed: string, inv: SetupInventory): Refusal[] {
  const out: Refusal[] = [];
  if (!inv.asker.canGrantDestructive) out.push(refuse('teamMd', 'Only a team lead or an admin may change TEAM.md.'));
  const next = teamFrontmatter(proposed);
  if (next === null) {
    out.push(refuse('teamMd', 'TEAM.md must start with a block between two lines of --- that reads as YAML.'));
    return out;
  }
  const before = readTeamDefaults(current);
  const after = readTeamDefaults(proposed);
  // a defaults block that cannot be read is never something a bot's setup may leave behind
  if (after.unreadable) out.push(refuse('teamMd', UNREADABLE_DEFAULTS_MESSAGE));
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  if (!same(before.runtimeAllowed, after.runtimeAllowed)) out.push(refuse('teamMd', 'The helper cannot change which tools (shell, files, browser) the team allows its bots. A lead does that by hand.'));
  if (before.guardPreset !== after.guardPreset) out.push(refuse('teamMd', "The helper cannot change the team's default guard. A lead does that by hand."));
  if (current === proposed) out.push(refuse('teamMd', 'This does not change TEAM.md.'));
  return out;
}

/** Formats refusals as the plain sentences the helper reads back. */
export const refusalText = (refusals: readonly Refusal[]): string => refusals.map((r) => `${r.field}: ${r.message}`).join('\n').slice(0, 3000);
