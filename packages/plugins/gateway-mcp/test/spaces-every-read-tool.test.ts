import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../src/catalog.ts';
import { withRunSpaces, type RunSpaces } from '../src/spaces.ts';

// P20-08 (D10): a tripwire. Every tool that READS must say how it stays inside the run's spaces, so a new read tool cannot ship quietly able to look in a
// place the run may not. Adding a read tool fails this file until the tool is classified below; the classification is then checked against the tool's own
// schema and against `withRunSpaces`, the one door every call goes through.
//
//   team_argument  the tool takes an optional `teamId`; `withRunSpaces` defaults it to the run's own team in a team context and refuses a team outside the list
//   run_scoped     the tool takes no place at all: it reads the run's own team or the run itself, through the run's reader transaction (the asker's policies)
//   asker_policies the tool takes a place only as a name of something the asker's own read policies already bound (a task id, a base name, the asker's own inbox)

const CLASS = {
  'messages.search': 'team_argument',
  'files.search': 'team_argument',
  'knowledge.search': 'team_argument',
  'memory.recall': 'run_scoped',
  'inbox.read': 'run_scoped',
  'tasks.read': 'asker_policies',
  'tasks.private_note': 'asker_policies',
} as const satisfies Record<string, 'team_argument' | 'run_scoped' | 'asker_policies'>;

const TEAM = '00000000-0000-7000-8000-0000000b0001';
const FOREIGN = '00000000-0000-7000-8000-0000000b0003';
const channel: RunSpaces = { audience: 'team', personId: null, teamIds: [TEAM], personalReason: 'team_audience' };
const dm: RunSpaces = { audience: 'personal', personId: '00000000-0000-7000-8000-0000000a0001', teamIds: [TEAM], personalReason: null };

const readTools = Object.entries(TOOLS).filter(([, t]) => t.kind === 'read');
const properties = (name: string): string[] => Object.keys(((TOOLS[name]!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}));

describe('every tool that reads stays inside the run’s spaces', () => {
  it('has a class for every read tool, and none for a tool that is gone', () => {
    const names = readTools.map(([n]) => n).sort();
    expect(Object.keys(CLASS).sort(), 'classify the new read tool in CLASS above, with how it stays inside the run’s spaces').toEqual(names);
  });

  it('lets no read tool take a key that names a space: `withRunSpaces` drops them before any tool sees them', () => {
    for (const [name] of readTools) {
      for (const space of [channel, dm]) {
        const out = withRunSpaces(name, { query: 'q', space: 'person:x', spaces: ['person:x'], personId: 'x', ownerPersonId: 'x' }, space, TEAM);
        expect(out, name).toMatchObject({ ok: true });
        if (out.ok) for (const key of ['space', 'spaces', 'personId', 'ownerPersonId']) expect(out.input, `${name} keeps ${key}`).not.toHaveProperty(key);
      }
    }
  });

  it('refuses a team outside the run’s list for every tool that takes a team, and defaults it to the run’s team in a team context', () => {
    // a tool with a `teamId` in its schema must be team_argument; the platform also fills `teamId` in for a team_argument tool whose schema does not list it
    for (const [name] of readTools) {
      if (properties(name).includes('teamId')) expect(CLASS[name as keyof typeof CLASS], `${name} takes a teamId so it must be team_argument`).toBe('team_argument');
    }
    for (const [name, kind] of Object.entries(CLASS)) {
      if (kind !== 'team_argument') continue;
      for (const space of [channel, dm]) expect(withRunSpaces(name, { query: 'q', teamId: FOREIGN }, space, TEAM), name).toMatchObject({ ok: false, code: 'other_space' });
      expect(withRunSpaces(name, { query: 'q' }, channel, TEAM), name).toEqual({ ok: true, input: { query: 'q', teamId: TEAM } });
    }
  });

  it('keeps a read tool from naming a place by any other key (a team, a person, a space, an owner)', () => {
    for (const [name] of readTools) {
      const bad = properties(name).filter((k) => /^(team|person|owner|space|workspace)/i.test(k) && k !== 'teamId');
      expect(bad, `${name} names a place by ${bad.join(', ')}`).toEqual([]);
    }
  });

  it('goes through the door on every call: `callTool` fits the input to the spaces before it authorizes or runs anything', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/protocol.ts', import.meta.url)), 'utf8');
    const call = source.indexOf('export async function callTool');
    expect(call).toBeGreaterThan(-1);
    const body = source.slice(call);
    const fit = body.indexOf('withRunSpaces(');
    expect(fit).toBeGreaterThan(-1);
    expect(body.indexOf('spacesFor(')).toBeGreaterThan(-1);
    expect(body.indexOf('spacesFor(')).toBeLessThan(fit);
    // nothing that decides or runs the call comes before the fit
    for (const later of ['ctx.runs.authorize(', 'asReader(', 'ctx.runs.invoke(', 'ctx.runs.call(']) {
      const at = body.indexOf(later);
      if (at !== -1) expect(at, `${later} runs before the spaces are applied`).toBeGreaterThan(fit);
    }
  });
});
