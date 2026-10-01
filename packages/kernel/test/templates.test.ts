import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
      expect.arrayContaining(['Brain', 'Orchestrator', 'Coder', 'Reviewer', 'Tester', 'Deploy', 'Standup relay', 'Alert triage']),
    );
    expect(eng?.roleTags).toContain('role:on-call');
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
  const put = async (id: string, yaml: string, teamMd: string | null = '# T\n'): Promise<void> => {
    await mkdir(path.join(tmp, id), { recursive: true });
    await writeFile(path.join(tmp, id, 'template.yaml'), yaml);
    if (teamMd !== null) await writeFile(path.join(tmp, id, 'TEAM.md'), teamMd);
  };
  const fresh = async (): Promise<void> => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
    tmp = await mkdtemp(path.join(os.tmpdir(), 'majlis-tpl-'));
  };

  beforeAll(fresh);
  afterAll(async () => rm(tmp, { recursive: true, force: true }));

  it('accepts a minimal valid template', async () => {
    await fresh();
    await put('t1', valid);
    expect((await loadTemplates(tmp))[0]?.teamMd).toBe('# T\n');
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
});
