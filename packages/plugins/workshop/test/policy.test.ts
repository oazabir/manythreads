import { parseBotMd, type BotFrontmatter } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { checkBotProposal, checkSkill, checkTeamMdChange } from '../src/policy.ts';
import { NO_TEAM_DEFAULTS, UNREADABLE_TEAM_DEFAULTS, presetAllowed, readTeamDefaults } from '../src/team-defaults.ts';
import { GOOD_BOT_MD, admin, inventory, member } from './fixtures.ts';

// P7-03: what propose_config refuses. Each case changes one thing in a good BOT.md and expects the refusal that names it.

const fm = (extra: string, base = GOOD_BOT_MD): BotFrontmatter => {
  const text = base.replace('---\n\nYou answer', `${extra}---\n\nYou answer`);
  const parsed = parseBotMd(text);
  if (!parsed.ok) throw new Error(`fixture does not parse: ${parsed.failure.message}`);
  return parsed.frontmatter;
};
const check = (frontmatter: BotFrontmatter, over: Parameters<typeof inventory>[0] = {}, slug = 'manual-helper', newSkills: string[] = []) =>
  checkBotProposal({ slug, frontmatter, inventory: inventory(over), newSkills, teamSlug: 'engineering' });
const fields = (frontmatter: BotFrontmatter, over: Parameters<typeof inventory>[0] = {}) => check(frontmatter, over).map((r) => r.field);
const good = (): BotFrontmatter => fm('');

describe('a bot within the defaults', () => {
  it('is not refused', () => expect(check(good())).toEqual([]));
});

describe('a slug', () => {
  it('that already belongs to a bot is refused: a bot that exists is changed on its own page', () => {
    const refused = check(good(), {}, 'brain');
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ field: 'slug' });
    expect(refused[0]!.message).toContain('already has a bot called "brain"');
  });
  it('"new" is refused: it is the address of the Add a bot page', () => expect(check(good(), {}, 'new').map((r) => r.field)).toEqual(['slug']));
  it('that is not a bot folder name is refused', () => expect(check(good(), {}, 'Not A Slug').map((r) => r.field)).toContain('slug'));
});

describe('where it runs', () => {
  it('a runner the team may use is fine', () => expect(fields(fm('placement:\n  runs_on: fast-model\n'))).toEqual([]));
  it('a runner the team may not use is refused, and the refusal lists only the runners the team may use', () => {
    const refused = check(fm('placement:\n  runs_on: secret-gpu-box\n'));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ field: 'placement.runs_on' });
    expect(refused[0]!.message).toContain('fast-model');
    expect(refused[0]!.message).not.toContain('secret-gpu-box is');
  });
  it('the old ways to place a bot (a gateway, a node, a runner machine) are refused', () => {
    expect(fields(fm('placement:\n  gateway:\n    connection: managed\n'))).toContain('placement');
    expect(fields(fm('placement:\n  node: box-1\n'))).toContain('placement');
  });
  it('a rules bot is refused: it is written by hand', () => {
    const rules = parseBotMd(GOOD_BOT_MD.replace('kind: agent', 'kind: automation').replace('runtime: hermes', 'runtime: rules'));
    expect(rules.ok && fields(rules.frontmatter)).toContain('runtime');
  });
});

describe('tools', () => {
  it('one that does not exist is refused', () => expect(fields(fm('', GOOD_BOT_MD.replace('messages.post]', 'messages.post, telepathy.read]')))).toContain('capabilities.native'));
  it('a whole group by wildcard is refused: tools are named one by one', () => expect(fields(fm('', GOOD_BOT_MD.replace('messages.post]', 'messages.*]')))).toContain('capabilities.native'));
  it('one that can change things needs "ask a person first" (approvals.needsApproval)', () => {
    const refused = check(fm('', GOOD_BOT_MD.replace('messages.post]', 'messages.post, email.send]')));
    expect(refused.map((r) => r.field)).toEqual(['approvals.needsApproval']);
  });
  it('one that can change things is fine for a lead when it asks first', () => {
    expect(check(fm('approvals:\n  needsApproval: [email.send]\n', GOOD_BOT_MD.replace('messages.post]', 'messages.post, email.send]')))).toEqual([]);
  });
  it('one that can change things is refused for a member even when it asks first: never more than the person may grant', () => {
    const body = fm('approvals:\n  needsApproval: [email.send]\n', GOOD_BOT_MD.replace('messages.post]', 'messages.post, email.send]'));
    const refused = check(body, { asker: member });
    expect(refused.map((r) => r.field)).toEqual(['capabilities.native']);
    expect(refused[0]!.message).toContain('only a team lead or an admin');
  });
  it('asking first about a tool that does not exist is refused', () => expect(fields(fm('approvals:\n  needsApproval: [email.teleport]\n'))).toContain('approvals.needsApproval'));
});

describe('shell, files and a browser (runtime capabilities)', () => {
  it('what the team allows is fine for a lead', () => expect(check(fm('', GOOD_BOT_MD.replace('capabilities:\n', 'capabilities:\n  runtime: [files]\n')))).toEqual([]));
  it('what the team has not allowed is refused, even for an admin', () => {
    const body = fm('', GOOD_BOT_MD.replace('capabilities:\n', 'capabilities:\n  runtime: [shell]\n'));
    expect(check(body).map((r) => r.field)).toEqual(['capabilities.runtime']);
    expect(check(body, { asker: admin }).map((r) => r.field)).toEqual(['capabilities.runtime']);
  });
  it('what the team allows is refused for a member: only a lead or an admin grants it', () => {
    const refused = check(fm('', GOOD_BOT_MD.replace('capabilities:\n', 'capabilities:\n  runtime: [files]\n')), { asker: member });
    expect(refused).toHaveLength(1);
    expect(refused[0]!.message).toContain('only a team lead or an admin');
  });
  it('a team that allows nothing refuses all three', () => {
    const body = fm('', GOOD_BOT_MD.replace('capabilities:\n', 'capabilities:\n  runtime: [shell, files, browser]\n'));
    expect(check(body, { runtimeAllowed: [] })).toHaveLength(3);
  });
  it('a connection to another app is refused: none exist', () => {
    expect(fields(fm('', GOOD_BOT_MD.replace('capabilities:\n', 'capabilities:\n  connections:\n    - name: mailbox\n      tools: [email.send]\n')))).toContain('capabilities.connections');
  });
});

describe('what starts it, what it reads, which model', () => {
  it('an inbox or a webhook trigger is refused: they need a connection', () => {
    expect(fields(fm('', GOOD_BOT_MD.replace('- type: conversation', '- type: inbox')))).toContain('triggers');
    expect(fields(fm('', GOOD_BOT_MD.replace('- type: conversation', '- type: webhook')))).toContain('triggers');
  });
  it('a knowledge base the team lacks is refused', () => expect(fields(fm('', GOOD_BOT_MD.replace('base: manuals', 'base: contracts')))).toContain('knowledge'));
  it('a skill the team lacks is refused unless the same proposal creates it', () => {
    const body = fm('skills: [triage]\n');
    expect(check(body).map((r) => r.field)).toEqual(['skills']);
    expect(check(body, {}, 'manual-helper', ['triage'])).toEqual([]);
  });
  it('a model that is not set up is refused, and a subscription model is an admin\'s choice', () => {
    expect(fields(fm('', GOOD_BOT_MD.replace('[smart, fast]', '[smart, code]')))).toContain('model');
    expect(fields(fm('', GOOD_BOT_MD.replace('aliases: [smart, fast]', 'subscription: claude-code')))).toContain('model.subscription');
  });
});

describe('who sees it and what it remembers', () => {
  it('a bot for the whole workspace is an admin\'s call', () => {
    const body = fm('visibility: workspace\n');
    expect(check(body).map((r) => r.field)).toEqual(['visibility']);
    expect(check(body, { asker: admin })).toEqual([]);
  });
  it('another team\'s memory bank is refused; writing to its own is for a lead or an admin', () => {
    expect(fields(fm('memory:\n  grants:\n    - bank: team:marketing\n      access: read\n'))).toContain('memory.grants');
    expect(check(fm('memory:\n  grants:\n    - bank: team:engineering\n      access: readwrite\n'))).toEqual([]);
    expect(check(fm('memory:\n  grants:\n    - bank: team:engineering\n      access: readwrite\n'), { asker: member }).map((r) => r.field)).toEqual(['memory.grants']);
  });
});

describe('the guard', () => {
  const preset = (name: string) => fm(`guard:\n  preset: ${name}\n`);
  it('anything goes under the standard default', () => {
    for (const p of ['standard', 'customer-facing', 'strict-egress', 'air-gapped']) expect(check(preset(p)), p).toEqual([]);
  });
  it('a bot may not be looser than the team default', () => {
    const strict = { guardDefault: 'customer-facing' };
    expect(check(preset('standard'), strict).map((r) => r.field)).toEqual(['guard.preset']);
    expect(check(good(), strict).map((r) => r.field)).toEqual(['guard.preset']);
    expect(check(preset('strict-egress'), strict).map((r) => r.field)).toEqual(['guard.preset']);
    expect(check(preset('customer-facing'), strict)).toEqual([]);
    expect(check(preset('air-gapped'), strict)).toEqual([]);
  });
  it('a preset that does not exist is refused', () => expect(fields(preset('lax'))).toContain('guard.preset'));
  it('presetAllowed is the one rule', () => {
    expect(presetAllowed('standard', 'standard')).toBe(true);
    expect(presetAllowed('strict-egress', 'customer-facing')).toBe(false);
    expect(presetAllowed('strict-egress', 'air-gapped')).toBe(true);
  });
});

describe('people it hands over to', () => {
  it('a role the team has is fine; a role it lacks or a named person is refused', () => {
    expect(check(fm('handover:\n  toPerson: [role:on-call]\n'))).toEqual([]);
    expect(fields(fm('handover:\n  toPerson: [role:nobody]\n'))).toContain('handover.toPerson');
    expect(fields(fm('approvals:\n  approvers: [person:abc]\n'))).toContain('approvals.approvers');
  });
  it('mayTag names bots that exist', () => {
    expect(check(fm('handover:\n  mayTag: [brain]\n'))).toEqual([]);
    expect(fields(fm('handover:\n  mayTag: [ghost]\n'))).toContain('handover.mayTag');
  });
  it('an evaluation set is left to a person', () => expect(fields(fm('evals:\n  set: x\n  minScore: 0.5\n'))).toContain('evals'));
});

describe('a skill proposed with the bot', () => {
  it('needs a new name and some text', () => {
    expect(checkSkill('triage', 'Steps to triage', inventory())).toEqual([]);
    expect(checkSkill('review', 'text', inventory()).map((r) => r.field)).toEqual(['skills.review']);
    expect(checkSkill('Bad Name', 'text', inventory())).toHaveLength(1);
    expect(checkSkill('triage', '  ', inventory())).toHaveLength(1);
  });
});

describe('a TEAM.md change proposed with the bot', () => {
  const team = (defaults: string, extra = '') => `---\nname: Engineering\n${extra}defaults:\n${defaults}---\n\n# Engineering\n`;
  const current = team('  botRuntime: [files]\n  guardPreset: standard\n');

  it('may add a line and keep the defaults', () => {
    expect(checkTeamMdChange(current, team('  botRuntime: [files]\n  guardPreset: standard\n', 'roleTags: [role:on-call]\n'), inventory())).toEqual([]);
  });
  it('may not widen what bots may be given, nor loosen the guard', () => {
    expect(checkTeamMdChange(current, team('  botRuntime: [files, shell]\n  guardPreset: standard\n'), inventory()).map((r) => r.message).join(' ')).toContain('which tools');
    expect(checkTeamMdChange(team('  guardPreset: customer-facing\n'), team('  guardPreset: standard\n'), inventory()).map((r) => r.message).join(' ')).toContain('default guard');
  });
  it('is for a lead or an admin, must be a team file, and must change something', () => {
    expect(checkTeamMdChange(current, team('  botRuntime: [files]\n  guardPreset: standard\n', 'x: 1\n'), inventory({ asker: member })).map((r) => r.message).join(' ')).toContain('Only a team lead');
    expect(checkTeamMdChange(current, 'no frontmatter', inventory())[0]!.message).toContain('TEAM.md must start');
    expect(checkTeamMdChange(current, current, inventory())[0]!.message).toContain('does not change');
  });
});

describe('the team defaults file keys', () => {
  it('a key that is left out means the documented default: no runtime tools, the standard guard', () => {
    expect(readTeamDefaults(null)).toEqual(NO_TEAM_DEFAULTS);
    expect(readTeamDefaults('# no frontmatter')).toEqual(NO_TEAM_DEFAULTS);
    expect(readTeamDefaults('---\nname: T\n---\n')).toEqual(NO_TEAM_DEFAULTS);
    expect(readTeamDefaults('---\ndefaults:\n  board: B\n---\n')).toEqual(NO_TEAM_DEFAULTS);
    expect(readTeamDefaults('---\ndefaults:\n---\n')).toEqual(NO_TEAM_DEFAULTS);
    expect(readTeamDefaults('---\n---\n')).toEqual(NO_TEAM_DEFAULTS);
  });
  it('know shell, files and browser and ignore the rest of the list', () => {
    expect(readTeamDefaults('---\ndefaults:\n  botRuntime: [files, network, shell]\n  guardPreset: customer-facing\n---\n')).toEqual({ runtimeAllowed: ['shell', 'files'], guardPreset: 'customer-facing', unreadable: false });
  });
  it('a key that is there but cannot be read is the STRICTEST answer, never the loosest', () => {
    for (const text of [
      '---\ndefaults:\n  botRuntime: files\n  guardPreset: lax\n---\n',
      '---\ndefaults:\n  guardPreset: lax\n---\n',
      '---\ndefaults:\n  guardPreset: [standard]\n---\n',
      '---\ndefaults:\n  botRuntime: shell\n---\n',
      '---\ndefaults: nothing\n---\n',
      '---\n: : bad\n---\n',
      '---\njust a line of text\n---\n',
    ]) {
      expect(readTeamDefaults(text), text).toEqual(UNREADABLE_TEAM_DEFAULTS);
    }
    expect(UNREADABLE_TEAM_DEFAULTS).toEqual({ runtimeAllowed: [], guardPreset: 'air-gapped', unreadable: true });
  });
  it('the strictest guard lets a bot use only the local model: nothing looser passes presetAllowed', () => {
    for (const looser of ['standard', 'customer-facing', 'strict-egress'] as const) expect(presetAllowed('air-gapped', looser)).toBe(false);
    expect(presetAllowed('air-gapped', 'air-gapped')).toBe(true);
  });
  it('a TEAM.md change that leaves the defaults unreadable is refused', () => {
    const current = '---\nname: E\ndefaults:\n  guardPreset: standard\n---\n';
    const broken = '---\nname: E\ndefaults:\n  guardPreset: lax\n---\n';
    const refused = checkTeamMdChange(current, broken, inventory()).map((r) => r.message).join(' ');
    expect(refused).toContain("can't be read");
    expect(refused).toContain('default guard');
  });
});

describe('what starts it', () => {
  const ft = (extra: string): BotFrontmatter => fm(extra, GOOD_BOT_MD.replace('triggers:\n  - type: conversation\n', ''));
  const channelsInv = { channels: [{ name: 'general' }, { name: 'dev' }] };
  it('a mention or channel_message in a channel the team has is fine', () => {
    expect(check(ft('triggers:\n  - type: channel_message\n    source:\n      channels: ["#dev"]\n  - type: mention\n    source:\n      channels: ["#general"]\n'), channelsInv)).toEqual([]);
  });
  it('a channel_message with no channels would read every message of every channel: refused', () => {
    const refused = check(ft('triggers:\n  - type: channel_message\n'), channelsInv);
    expect(refused.map((r) => r.field)).toEqual(['triggers']);
    expect(refused[0]!.message).toContain('every message in every channel');
  });
  it('a channel the asker cannot see (not in the inventory), a private one or one that does not exist is refused, and the refusal lists only what they can see', () => {
    const refused = check(ft('triggers:\n  - type: channel_message\n    source:\n      channels: ["#board-secrets"]\n  - type: mention\n    source:\n      channels: ["#nowhere"]\n'), channelsInv);
    expect(refused).toHaveLength(2);
    expect(refused[0]!.message).toContain('"#board-secrets"');
    expect(refused[0]!.message).toContain('#general, #dev');
    expect(refused[0]!.message).not.toContain('board-secrets,');
  });
  it('a mention with no channels is fine: it fires only when someone names the bot', () => {
    expect(check(ft('triggers:\n  - type: mention\n'), channelsInv)).toEqual([]);
  });
});
