import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadTemplates, TemplateLoadError } from '../src/templates/index.ts';

const templatesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../templates');

describe('shipped templates', () => {
  it('loads and validates all five, each with Brain, unique ids', async () => {
    const all = await loadTemplates(templatesDir);
    expect(all.map((t) => t.id)).toEqual(['customer-support', 'engineering', 'marketing', 'product-design', 'research']);
    expect(new Set(all.map((t) => t.id)).size).toBe(all.length);
    for (const t of all) {
      expect(t.bots.some((b) => b.slug === 'brain' && b.name === 'Brain')).toBe(true);
      expect(t.teamMd).toContain(`name: ${t.name}`);
      expect(t.board.columns.length).toBeGreaterThan(0);
    }
  });

  it('Engineering lists the six channels, a board and Brain', async () => {
    const eng = (await loadTemplates(templatesDir)).find((t) => t.id === 'engineering');
    expect(eng?.channels.map((c) => c.name)).toEqual(['#general', '#dev', '#releases', '#incidents', '#alerts', '#standup']);
    expect(eng?.board.name).toBeTruthy();
    expect(eng?.bots.map((b) => b.name)).toEqual(
      expect.arrayContaining(['Brain', 'Engineer', 'Plan reviewer', 'Coder', 'Code reviewer', 'Tester', 'Deployer', 'Web smoke tester', 'Standup relay', 'Alert triage']),
    );
    expect(eng?.roleTags).toContain('role:on-call');
  });

  it('Engineering ships the whole chain of bots, and the server image carries the templates folder', async () => {
    const eng = (await loadTemplates(templatesDir)).find((t) => t.id === 'engineering')!;
    expect(eng.bots.map((b) => b.slug).sort()).toEqual(
      ['alert-triage', 'brain', 'code-reviewer', 'coder', 'committer', 'deployer', 'engineer', 'plan-reviewer', 'standup-relay', 'tester', 'web-smoke-tester'].sort(),
    );
    // a fresh install reads `templates/` from the image: the server's docker ignore list must never drop it
    const ignored = (await readFile(path.resolve(templatesDir, '../deploy/docker/server.Dockerfile.dockerignore'), 'utf8')).split('\n').map((l) => l.trim());
    expect(ignored.filter((l) => l === 'templates' || l === 'templates/' || l === '/templates')).toEqual([]);
  });

  it('ships Brain and its scenario set in every template, and the three minimal bots in their own teams', async () => {
    const all = await loadTemplates(templatesDir);
    for (const t of all) {
      expect(Object.keys(t.files ?? {}), t.id).toEqual(expect.arrayContaining(['bots/brain/BOT.md', 'bots/brain/evals/brain.yaml']));
    }
    const definitions = Object.fromEntries(all.map((t) => [t.id, Object.keys(t.files ?? {}).filter((k) => k.endsWith('/BOT.md')).sort()]));
    expect(definitions).toEqual({
      'customer-support': ['bots/brain/BOT.md', 'bots/support-responder/BOT.md'],
      engineering: [
        'bots/alert-triage/BOT.md',
        'bots/brain/BOT.md',
        'bots/code-reviewer/BOT.md',
        'bots/coder/BOT.md',
        'bots/committer/BOT.md',
        'bots/deployer/BOT.md',
        'bots/engineer/BOT.md',
        'bots/plan-reviewer/BOT.md',
        'bots/standup-relay/BOT.md',
        'bots/tester/BOT.md',
        'bots/web-smoke-tester/BOT.md',
      ],
      marketing: ['bots/brain/BOT.md', 'bots/content-drafter/BOT.md'],
      'product-design': ['bots/brain/BOT.md'],
      research: ['bots/brain/BOT.md'],
    });
  });

  it('channel sets match SPEC §13', async () => {
    const byId = Object.fromEntries((await loadTemplates(templatesDir)).map((t) => [t.id, t.channels.map((c) => c.name)]));
    expect(byId['customer-support']).toEqual(['#support', '#escalations', '#enquiries', '#kb-updates']);
    expect(byId.marketing).toEqual(['#campaigns', '#content', '#social', '#analytics', '#brand']);
    expect(byId.research).toEqual(['#papers', '#experiments', '#notes', '#reading-group']);
    expect(byId['product-design']).toEqual(['#design', '#feedback', '#specs', '#critique']);
  });
});

describe('loader errors', () => {
  let tmp: string;
  const valid = `id: t1
name: T1
description: d
version: 1
channels:
  - name: "#general"
    purpose: p
board:
  name: B
  columns: [Open]
bots:
  - slug: brain
    name: Brain
    role: r
roleTags: []
`;
  const brainMd = '---\nname: Brain\nrole: r\nkind: agent\nruntime: hermes\n---\n\n# Brain\n';
  const putFile = async (id: string, file: string, text: string): Promise<void> => {
    await mkdir(path.dirname(path.join(tmp, id, file)), { recursive: true });
    await writeFile(path.join(tmp, id, file), text);
  };
  const put = async (id: string, yaml: string, teamMd: string | null = '# T\n', brain: string | null = brainMd): Promise<void> => {
    await mkdir(path.join(tmp, id), { recursive: true });
    await writeFile(path.join(tmp, id, 'template.yaml'), yaml);
    if (teamMd !== null) await writeFile(path.join(tmp, id, 'TEAM.md'), teamMd);
    if (brain !== null) await putFile(id, 'bots/brain/BOT.md', brain);
  };
  const fresh = async (): Promise<void> => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
    tmp = await mkdtemp(path.join(os.tmpdir(), 'manythreads-tpl-'));
  };

  beforeAll(fresh);
  afterAll(async () => rm(tmp, { recursive: true, force: true }));

  it('accepts a minimal valid template', async () => {
    await fresh();
    await put('t1', valid);
    const t = (await loadTemplates(tmp))[0];
    expect(t?.teamMd).toBe('# T\n');
    expect(t?.files).toEqual({ 'bots/brain/BOT.md': brainMd });
  });

  it('names file and field for a bad channel name', async () => {
    await fresh();
    await put('t1', valid.replace('"#general"', '"general"'));
    const err = await loadTemplates(tmp).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TemplateLoadError);
    expect((err as TemplateLoadError).message).toContain(path.join('t1', 'template.yaml'));
    expect((err as TemplateLoadError).field).toBe('channels.0.name');
  });

  it('rejects unknown keys and names them', async () => {
    await fresh();
    await put('t1', `${valid}extra: 1\n`);
    await expect(loadTemplates(tmp)).rejects.toThrow(/template\.yaml: extra/);
  });

  it('rejects a missing Brain', async () => {
    await fresh();
    await put('t1', valid.replace('slug: brain', 'slug: helper'));
    await expect(loadTemplates(tmp)).rejects.toThrow(/bots: .*Brain/);
  });

  it('rejects a missing TEAM.md, bad YAML, and an id that differs from its folder', async () => {
    await fresh();
    await put('t1', valid, null);
    await expect(loadTemplates(tmp)).rejects.toThrow(/TEAM\.md: cannot read/);
    await fresh();
    await put('t1', 'id: [unclosed\n');
    await expect(loadTemplates(tmp)).rejects.toThrow(/invalid YAML/);
    await fresh();
    await put('t2', valid);
    await expect(loadTemplates(tmp)).rejects.toThrow(/id: "t1" must match folder name "t2"/);
  });

  describe('bot files', () => {
    const evalSet = (name = 'brain'): string =>
      `set: ${name}\ncases:\n  - id: one\n    question: Why?\n    expect:\n      statesUnknown: true\n    rationale: r\n`;
    const withEvals = (set: string): string => brainMd.replace('runtime: hermes\n', `runtime: hermes\nevals:\n  set: ${set}\n  minScore: 1\n`);

    it('reads bots/<slug>/BOT.md and evals/<set>.yaml of the bots the template lists', async () => {
      await fresh();
      await put('t1', valid.replace('bots:\n', 'bots:\n  - slug: coder\n    name: Coder\n    role: r\n'), '# T\n', withEvals('brain'));
      await putFile('t1', 'bots/brain/evals/brain.yaml', evalSet());
      await putFile('t1', 'bots/coder/BOT.md', brainMd.replace('name: Brain', 'name: Coder'));
      const t = (await loadTemplates(tmp))[0];
      expect(Object.keys(t?.files ?? {})).toEqual(['bots/brain/BOT.md', 'bots/brain/evals/brain.yaml', 'bots/coder/BOT.md']);
    });

    it("requires Brain's definition", async () => {
      await fresh();
      await put('t1', valid, '# T\n', null);
      await expect(loadTemplates(tmp)).rejects.toThrow(/bots[\\/]brain[\\/]BOT\.md: every team template ships Brain/);
    });

    it('names the file and the field of a definition that does not parse', async () => {
      await fresh();
      await put('t1', valid, '# T\n', brainMd.replace('kind: agent', 'kind: robot'));
      const err = await loadTemplates(tmp).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TemplateLoadError);
      expect((err as TemplateLoadError).message).toContain(path.join('bots', 'brain', 'BOT.md'));
      expect((err as TemplateLoadError).field).toBe('kind');
    });

    it("refuses an evals.set with no file, a set whose name is not its file's, and a case that asserts nothing", async () => {
      await fresh();
      await put('t1', valid, '# T\n', withEvals('brain'));
      await expect(loadTemplates(tmp)).rejects.toThrow(/evals\.set: names "brain" but bots\/brain\/evals\/brain\.yaml does not exist/);
      await putFile('t1', 'bots/brain/evals/brain.yaml', evalSet('other'));
      await expect(loadTemplates(tmp)).rejects.toThrow(/set: "other" must match the file name "brain"/);
      await putFile('t1', 'bots/brain/evals/brain.yaml', evalSet().replace('statesUnknown: true', '{}'));
      await expect(loadTemplates(tmp)).rejects.toThrow(/must assert something/);
    });

    it('refuses a file that is not a definition or a scenario set, and a bot the template does not list', async () => {
      await fresh();
      await put('t1', valid);
      await putFile('t1', 'bots/brain/memory.md', '# m\n');
      await expect(loadTemplates(tmp)).rejects.toThrow(/holds BOT\.md and evals\/<set>\.yaml only/);
      await fresh();
      await put('t1', valid);
      await putFile('t1', 'bots/ghost/BOT.md', brainMd);
      await expect(loadTemplates(tmp)).rejects.toThrow(/"ghost" is not one of the template's bots/);
      await fresh();
      await put('t1', `${valid}files: {}\n`);
      await expect(loadTemplates(tmp)).rejects.toThrow(/files: come from the bots\/ folder/);
    });
  });
});
