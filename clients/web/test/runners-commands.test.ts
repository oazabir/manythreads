import { describe, expect, it } from 'vitest';
import type { OldConnection, TeamId } from '@manythreads/shared';
import {
  KIND_CARDS,
  addedWords,
  editChanged,
  teamOptions,
  NO_TEAMS,
  adoptWords,
  cannotBeDefault,
  cannotSwitchOff,
  choiceOf,
  countBots,
  defaultWords,
  deleteWarning,
  describeGateway,
  describeOld,
  describeTeams,
  emptyForm,
  hasNoTeams,
  stateLook,
  suggestName,
  switchMode,
  switchWords,
  teamsBody,
  teamsProblem,
  teamsSavedWords,
  testProfile,
  testWords,
  toggleTeam,
  validateEdit,
  validateNew,
  type TeamsChoice,
} from '../src/screens/admin/runners/commands';

/*
 * The model of the Runners page (PLAN P19-04): the words an admin reads and the checks a form makes before it asks the server. The screen is React and is
 * proved in Playwright (e2e/admin/runners.spec.ts); these tests hold the parts a wrong line would break without a sound.
 */

const T1 = '00000000-0000-7000-8000-0000000b0001' as TeamId;
const T2 = '00000000-0000-7000-8000-0000000b0002' as TeamId;
const T3 = '00000000-0000-7000-8000-0000000b0003' as TeamId;
const team = (id: TeamId, name: string) => ({ teamId: id, slug: name.toLowerCase(), name });

const KEY = 'gateway-key-0123456789';
const form = (patch: Partial<ReturnType<typeof emptyForm>> = {}) => ({ ...emptyForm(), label: 'Office Hermes', name: 'office-hermes', ...patch });

describe('the chooser of kinds', () => {
  it('offers the five kinds with one sentence each; Claude Code and Codex are shown but cannot be picked yet', () => {
    expect(KIND_CARDS.map((c) => c.kind)).toEqual(['hermes_gateway', 'hermes_pod', 'claude_cli', 'codex_cli', 'llm_gateway']);
    for (const c of KIND_CARDS) expect(c.sentence.length, c.kind).toBeGreaterThan(20);
    expect(KIND_CARDS.filter((c) => c.available).map((c) => c.kind)).toEqual(['hermes_gateway', 'hermes_pod', 'llm_gateway']);
    expect(KIND_CARDS.find((c) => c.kind === 'claude_cli')?.unavailable).toBe('Needs a Claude sign-in; coming with the Claude pod.');
    expect(KIND_CARDS.find((c) => c.kind === 'codex_cli')?.unavailable).toBe('Needs a Codex sign-in; coming with the Claude pod.');
  });

  it('uses no plan or phase wording', () => {
    const text = JSON.stringify(KIND_CARDS);
    expect(text).not.toMatch(/P19|\bphase\b|\bPLAN\b/);
  });
});

describe('state badges', () => {
  it('names every state in words with a shape of its own, so colour is never the only cue', () => {
    const states = ['not_set_up', 'waiting_for_sign_in', 'starting', 'ready', 'needs_sign_in', 'waiting_for_node', 'moving', 'paused', 'off'] as const;
    expect(states.map((s) => stateLook(s).label)).toEqual(['Not set up', 'Waiting for sign-in', 'Starting', 'Ready', 'Needs sign-in', 'Waiting for node', 'Moving', 'Paused', 'Off']);
    for (const s of states) expect(stateLook(s).glyph.length, s).toBeGreaterThan(0);
    expect(stateLook('ready').glyph).not.toBe(stateLook('not_set_up').glyph);
    expect(stateLook('off').glyph).not.toBe(stateLook('ready').glyph);
  });
});

describe('what the list says', () => {
  it('words who may use a runner', () => {
    expect(describeTeams({ allTeams: true, teams: [] })).toBe('Every team');
    expect(describeTeams({ allTeams: false, teams: [] })).toBe('No team yet');
    expect(describeTeams({ allTeams: false, teams: [team(T1, 'Engineering')] })).toBe('Engineering');
    expect(describeTeams({ allTeams: false, teams: [team(T1, 'Engineering'), team(T2, 'Marketing')] })).toBe('Engineering and Marketing');
    expect(describeTeams({ allTeams: false, teams: [team(T1, 'Engineering'), team(T2, 'Marketing'), team(T3, 'Research')] })).toBe('Engineering, Marketing and 1 more');
    expect(hasNoTeams({ allTeams: false, teams: [] })).toBe(true);
    expect(hasNoTeams({ allTeams: true, teams: [] })).toBe(false);
  });

  it('counts bots', () => {
    expect([0, 1, 4].map(countBots)).toEqual(['No bots', '1 bot', '4 bots']);
  });

  it('shows a gateway’s address and whether a key is set, never a key', () => {
    expect(describeGateway({ kind: 'hermes_gateway', baseUrl: 'https://hermes.example.com', hasKey: true })).toBe('https://hermes.example.com · A key is set');
    expect(describeGateway({ kind: 'hermes_gateway', baseUrl: null, hasKey: false })).toBe('No address yet · No key yet');
    expect(describeGateway({ kind: 'hermes_pod', baseUrl: null, hasKey: false })).toBeNull();
  });

  it('says why the default cannot be switched off or a runner cannot become the default', () => {
    expect(cannotSwitchOff({ isDefault: true, enabled: true })).toContain('Make another runner the default first');
    expect(cannotSwitchOff({ isDefault: false, enabled: true })).toBeNull();
    expect(cannotBeDefault({ kind: 'hermes_gateway', enabled: true })).toBeNull();
    expect(cannotBeDefault({ kind: 'hermes_pod', enabled: true })).toBeNull();
    expect(cannotBeDefault({ kind: 'hermes_gateway', enabled: false })).toContain('switched off');
    expect(cannotBeDefault({ kind: 'llm_gateway', enabled: true })).toContain('cannot be the default yet');
  });

  it('announces a change in a full sentence', () => {
    expect(switchWords({ label: 'Office Hermes' }, false)).toBe('Office Hermes is switched off.');
    expect(switchWords({ label: 'Office Hermes' }, true)).toBe('Office Hermes is switched on.');
    expect(defaultWords({ label: 'Office Hermes' })).toBe('Office Hermes is now the default runner.');
    expect(defaultWords(null)).toBe('There is no default runner now.');
    expect(teamsSavedWords({ label: 'A', allTeams: true, teams: [] })).toBe('A is open to every team.');
    expect(teamsSavedWords({ label: 'A', allTeams: false, teams: [] })).toBe('A is not open to any team.');
    expect(teamsSavedWords({ label: 'A', allTeams: false, teams: [team(T1, 'Engineering'), team(T2, 'Marketing')] })).toBe('A is open to Engineering, Marketing.');
  });

  it('words a test result from the fixed sentences without adding to them', () => {
    expect(testWords({ label: 'A' }, { ok: true, error: null, status: 'ready' })).toBe('A answered. It is ready.');
    expect(testWords({ label: 'A' }, { ok: false, error: 'The gateway refused the API key. Use the key in the profile’s .env (API_SERVER_KEY).', status: 'not_set_up' })).toBe(
      'A did not pass: The gateway refused the API key. Use the key in the profile’s .env (API_SERVER_KEY).',
    );
  });

  it('warns before a delete when bots still run on the runner, with the count', () => {
    expect(deleteWarning({ label: 'Office Hermes', botCount: 0 })).toBeNull();
    expect(deleteWarning({ label: 'Office Hermes', botCount: 1 })).toBe('1 bot still runs on Office Hermes. It cannot be deleted until that bot is moved to another runner.');
    expect(deleteWarning({ label: 'Office Hermes', botCount: 3 })).toBe('3 bots still run on Office Hermes. It cannot be deleted until they are moved to another runner.');
  });
});

describe('the teams control', () => {
  it('reads a runner into the right mode', () => {
    expect(choiceOf({ allTeams: true, teams: [] })).toEqual({ mode: 'all' });
    expect(choiceOf({ allTeams: false, teams: [team(T1, 'Engineering')] })).toEqual({ mode: 'one', teamId: T1 });
    expect(choiceOf({ allTeams: false, teams: [team(T1, 'Engineering'), team(T2, 'Marketing')] })).toEqual({ mode: 'several', teamIds: [T1, T2] });
    expect(choiceOf({ allTeams: false, teams: [] })).toEqual({ mode: 'several', teamIds: [] });
  });

  it('turns a choice into the body the server takes', () => {
    expect(teamsBody({ mode: 'all' })).toEqual({ all: true });
    expect(teamsBody({ mode: 'one', teamId: T1 })).toEqual({ teams: [T1] });
    expect(teamsBody({ mode: 'one', teamId: '' })).toBeNull();
    expect(teamsBody({ mode: 'several', teamIds: [T1, T3] })).toEqual({ teams: [T1, T3] });
    expect(teamsBody(NO_TEAMS)).toEqual({ teams: [] });
  });

  it('keeps what carries over when the shortcuts change the mode', () => {
    const several: TeamsChoice = { mode: 'several', teamIds: [T2, T3] };
    expect(switchMode(several, 'one')).toEqual({ mode: 'one', teamId: T2 });
    expect(switchMode({ mode: 'one', teamId: T1 }, 'several')).toEqual({ mode: 'several', teamIds: [T1] });
    expect(switchMode(several, 'all')).toEqual({ mode: 'all' });
    expect(switchMode({ mode: 'all' }, 'one')).toEqual({ mode: 'one', teamId: '' });
    expect(switchMode(several, 'several')).toBe(several);
  });

  it('ticks and unticks teams without repeating one', () => {
    let c: TeamsChoice = NO_TEAMS;
    c = toggleTeam(c, T1, true);
    c = toggleTeam(c, T2, true);
    c = toggleTeam(c, T1, true);
    expect(c).toEqual({ mode: 'several', teamIds: [T2, T1] });
    expect(toggleTeam(c, T2, false)).toEqual({ mode: 'several', teamIds: [T1] });
    expect(toggleTeam({ mode: 'all' }, T1, true)).toEqual({ mode: 'all' });
  });

  it('refuses "this team only" with no team and warns, without refusing, when nobody is ticked', () => {
    expect(teamsProblem({ mode: 'one', teamId: '' })).toEqual({ kind: 'error', text: 'Choose the team.' });
    expect(teamsProblem(NO_TEAMS)?.kind).toBe('warning');
    expect(teamsProblem({ mode: 'several', teamIds: [T1] })).toBeNull();
    expect(teamsProblem({ mode: 'all' })).toBeNull();
  });
});

describe('the Hermes gateway form', () => {
  const good = form({ baseUrl: 'https://hermes.example.com:8642', apiKey: KEY, teams: { mode: 'one', teamId: T1 } });

  it('builds the body the server takes, with the default profile rule', () => {
    const r = validateNew('hermes_gateway', good);
    expect(r).toEqual({
      ok: true,
      body: { name: 'office-hermes', label: 'Office Hermes', kind: 'hermes_gateway', baseUrl: 'https://hermes.example.com:8642', apiKey: KEY, profileRule: '{bot}', teams: { teams: [T1] } },
    });
  });

  it('trims the readable name, the short name and the address', () => {
    const r = validateNew('hermes_gateway', { ...good, label: '  Office Hermes ', name: ' office-hermes ', baseUrl: ' https://hermes.example.com ' });
    expect(r.ok && r.body.label).toBe('Office Hermes');
    expect(r.ok && r.body.name).toBe('office-hermes');
    expect(r.ok && r.body.baseUrl).toBe('https://hermes.example.com');
  });

  it('says what is wrong with each field in plain words', () => {
    const r = validateNew('hermes_gateway', { ...emptyForm(), label: '', name: 'Bad Name', baseUrl: 'ftp://x', apiKey: 'short', profileRule: 'no-placeholder', teams: { mode: 'one', teamId: '' } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(['apiKey', 'baseUrl', 'label', 'name', 'profileRule', 'teams']);
    expect(r.errors.name).toMatch(/lowercase letters/);
    expect(r.errors.baseUrl).toMatch(/http or https/);
    expect(r.errors.profileRule).toContain('{bot}');
    for (const text of Object.values(r.errors)) expect(text).not.toMatch(/zod|schema|invalid_|expected/i);
  });

  it('asks for the key when it is empty, and refuses an address that carries a password or a query', () => {
    const noKey = validateNew('hermes_gateway', { ...good, apiKey: '' });
    expect(!noKey.ok && noKey.errors.apiKey).toBe('Type the gateway’s key.');
    expect(validateNew('hermes_gateway', { ...good, baseUrl: 'https://u:p@hermes.example.com' }).ok).toBe(false);
    expect(validateNew('hermes_gateway', { ...good, baseUrl: 'https://hermes.example.com/?a=1' }).ok).toBe(false);
  });

  it('accepts a profile rule with the placeholder inside other text, and falls back to {bot} when it is left empty', () => {
    const custom = validateNew('hermes_gateway', { ...good, profileRule: 'mt-{bot}' });
    expect(custom.ok && custom.body.profileRule).toBe('mt-{bot}');
    const blank = validateNew('hermes_gateway', { ...good, profileRule: '  ' });
    expect(blank.ok && blank.body.profileRule).toBe('{bot}');
  });

  it('sends no key and no address for kinds that have none', () => {
    const r = validateNew('hermes_pod', form({ teams: { mode: 'all' } }));
    expect(r).toEqual({ ok: true, body: { name: 'office-hermes', label: 'Office Hermes', kind: 'hermes_pod', teams: { all: true } } });
  });
});

describe('the LLM gateway form', () => {
  it('needs a model name chosen from the list', () => {
    const none = validateNew('llm_gateway', form());
    expect(!none.ok && none.errors.modelAlias).toBe('Choose a model name.');
    const ok = validateNew('llm_gateway', form({ modelAlias: 'smart', teams: { mode: 'several', teamIds: [T1, T2] } }));
    expect(ok).toEqual({ ok: true, body: { name: 'office-hermes', label: 'Office Hermes', kind: 'llm_gateway', modelAlias: 'smart', teams: { teams: [T1, T2] } } });
  });
});

describe('changing a runner', () => {
  const gateway = { kind: 'hermes_gateway', label: 'Office Hermes', baseUrl: 'https://hermes.example.com', profileRule: '{bot}', modelAlias: null } as const;
  const same = { label: 'Office Hermes', baseUrl: 'https://hermes.example.com', apiKey: '', profileRule: '{bot}', modelAlias: '' };

  it('sends only what changed, and nothing when nothing did', () => {
    expect(validateEdit(gateway, same)).toEqual({ ok: true, body: {}, changed: false });
    expect(validateEdit(gateway, { ...same, label: 'Home Hermes' })).toEqual({ ok: true, body: { label: 'Home Hermes' }, changed: true });
    expect(validateEdit(gateway, { ...same, baseUrl: 'https://other.example.com' })).toEqual({ ok: true, body: { baseUrl: 'https://other.example.com' }, changed: true });
  });

  it('a blank key keeps the key; a typed one replaces it', () => {
    expect(validateEdit(gateway, same).ok && 'apiKey' in (validateEdit(gateway, same) as { body: object }).body).toBe(false);
    expect(validateEdit(gateway, { ...same, apiKey: KEY })).toEqual({ ok: true, body: { apiKey: KEY }, changed: true });
    const short = validateEdit(gateway, { ...same, apiKey: 'tiny' });
    expect(!short.ok && short.errors.apiKey).toBe('The key is at least 8 characters.');
  });

  it('only an LLM gateway can change its model name; a pod changes only its label', () => {
    const llm = { kind: 'llm_gateway', label: 'Plain', baseUrl: null, profileRule: null, modelAlias: 'smart' } as const;
    expect(validateEdit(llm, { ...same, label: 'Plain', baseUrl: '', profileRule: '', modelAlias: 'fast' })).toEqual({ ok: true, body: { modelAlias: 'fast' }, changed: true });
    const pod = { kind: 'hermes_pod', label: 'Pods', baseUrl: null, profileRule: '{bot}', modelAlias: null } as const;
    expect(validateEdit(pod, { ...same, label: 'Pods', baseUrl: 'https://ignored.example.com', apiKey: KEY })).toEqual({ ok: true, body: {}, changed: false });
  });
});

describe('names', () => {
  it('makes a short name from the readable one', () => {
    expect(suggestName('Office Hermes')).toBe('office-hermes');
    expect(suggestName('  Café  Hermes!! ')).toBe('cafe-hermes');
    expect(suggestName('Team Hermes pod')).toBe('team-hermes-pod');
    expect(suggestName('***')).toBe('');
    expect(suggestName('x'.repeat(100))).toHaveLength(63);
  });
});

describe('the test dialog', () => {
  it('takes an empty profile as the gateway’s default and refuses what is not a profile name', () => {
    expect(testProfile('')).toEqual({ ok: true });
    expect(testProfile('  ')).toEqual({ ok: true });
    expect(testProfile(' probe ')).toEqual({ ok: true, profile: 'probe' });
    expect(testProfile('../etc').ok).toBe(false);
    expect(testProfile('a/b').ok).toBe(false);
  });
});

describe('the old connections', () => {
  const managed: Pick<OldConnection, 'teamName' | 'kind' | 'agent' | 'botCount'> = { teamName: 'Engineering', kind: 'managed', agent: 'hermes', botCount: 2 };
  const external: Pick<OldConnection, 'teamName' | 'kind' | 'agent' | 'botCount'> = { teamName: 'Marketing', kind: 'external', agent: 'hermes', botCount: 0 };

  it('says whose connection it is, what it is and how many bots use it', () => {
    expect(describeOld(managed)).toBe("Engineering · the team's own Hermes pod · 2 bots");
    expect(describeOld(external)).toBe('Marketing · a Hermes gateway · No bots');
    expect(describeOld({ ...external, agent: 'claude-code' })).toContain('a Claude Code connection');
    expect(describeOld({ ...external, agent: 'codex' })).toContain('a Codex connection');
  });

  it('says what adopting does and that bots are not touched', () => {
    expect(adoptWords(managed)).toBe('Adopting adds Engineering to the shared team pod runner. Nothing changes for its bots.');
    expect(adoptWords(external)).toContain('its own copy of the key, for Marketing only');
  });
});

describe('teams the page cannot list (archived or hidden)', () => {
  it('keeps every team already on the runner, named, after the live teams, so saving never drops one', () => {
    const loaded = [{ id: T1, name: 'Engineering' }, { id: T2, name: 'Marketing' }];
    const onRunner = [{ teamId: T2, name: 'Marketing' }, { teamId: T3, name: 'Old team' }];
    expect(teamOptions(loaded, onRunner)).toEqual([
      { id: T1, name: 'Engineering' },
      { id: T2, name: 'Marketing' },
      { id: T3, name: 'Old team (archived or hidden)' },
    ]);
    expect(teamOptions(loaded, [])).toEqual(loaded);
  });
});

describe('the edit form and the add message', () => {
  const pod = { kind: 'hermes_pod', label: 'Pods', baseUrl: null, profileRule: '{bot}', modelAlias: null } as const;
  const same = { label: 'Pods', baseUrl: '', apiKey: '', profileRule: '{bot}', modelAlias: '' };
  it('has something to save only when a field differs, and a pod differs by its name only', () => {
    expect(editChanged(pod, same)).toBe(false);
    expect(editChanged(pod, { ...same, label: 'More pods' })).toBe(true);
    expect(editChanged(pod, { ...same, baseUrl: 'https://ignored.example.com' })).toBe(false);
    const gw = { kind: 'hermes_gateway', label: 'G', baseUrl: 'https://g.example.com', profileRule: '{bot}', modelAlias: null } as const;
    expect(editChanged(gw, { ...same, label: 'G', baseUrl: 'https://g.example.com' })).toBe(false);
    expect(editChanged(gw, { ...same, label: 'G', baseUrl: 'https://g.example.com', apiKey: KEY })).toBe(true);
  });
  it('says a runner with no team is not open to any team', () => {
    expect(addedWords({ label: 'X', kind: 'hermes_gateway', allTeams: false, teams: [] })).toBe('X was added. It is not open to any team yet: choose its teams.');
    expect(addedWords({ label: 'X', kind: 'hermes_gateway', allTeams: true, teams: [] })).toBe('X was added. Run Test to check it.');
    expect(addedWords({ label: 'X', kind: 'llm_gateway', allTeams: true, teams: [] })).toBe('X was added.');
  });
});
