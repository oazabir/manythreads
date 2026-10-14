import { describe, expect, it } from 'vitest';
import { TEMPLATE_FILES_MAX, TeamTemplate, templateDefinitionOf } from '../src/index.ts';

const ok = {
  id: 'engineering',
  name: 'Engineering',
  description: 'Ship software.',
  version: 1,
  channels: [{ name: '#general', purpose: 'Everyone.' }, { name: '#secret', private: true, purpose: 'Leads.' }],
  board: { name: 'Board', columns: ['Open', 'Done'] },
  bots: [{ slug: 'brain', name: 'Brain', role: 'Memory.' }],
  roleTags: ['role:on-call'],
  teamMd: '# Engineering\n',
};

describe('TeamTemplate', () => {
  it('round-trips a valid template', () => {
    expect(TeamTemplate.parse(ok)).toEqual(ok);
  });

  it('rejects unknown keys at every level (strict)', () => {
    expect(TeamTemplate.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(TeamTemplate.safeParse({ ...ok, board: { ...ok.board, extra: 1 } }).success).toBe(false);
    expect(TeamTemplate.safeParse({ ...ok, channels: [{ name: '#a', purpose: 'p', extra: 1 }] }).success).toBe(false);
    expect(TeamTemplate.safeParse({ ...ok, bots: [{ ...ok.bots[0], extra: 1 }] }).success).toBe(false);
  });

  it('requires Brain', () => {
    expect(TeamTemplate.safeParse({ ...ok, bots: [{ slug: 'coder', name: 'Coder', role: 'r' }] }).success).toBe(false);
  });

  it('rejects malformed channel names, role tags, duplicates and bad versions', () => {
    expect(TeamTemplate.safeParse({ ...ok, channels: [{ name: 'general', purpose: 'p' }] }).success).toBe(false);
    expect(TeamTemplate.safeParse({ ...ok, channels: [{ name: '#General', purpose: 'p' }] }).success).toBe(false);
    expect(TeamTemplate.safeParse({ ...ok, roleTags: ['on-call'] }).success).toBe(false);
    expect(TeamTemplate.safeParse({ ...ok, channels: [ok.channels[0], ok.channels[0]] }).success).toBe(false);
    expect(TeamTemplate.safeParse({ ...ok, version: 0 }).success).toBe(false);
  });

  it('carries the bot files a template ships, one folder deep, for bots it lists', () => {
    const files = { 'bots/brain/BOT.md': '---\nname: Brain\n---\n', 'bots/brain/evals/brain.yaml': 'set: brain\n' };
    expect(TeamTemplate.parse({ ...ok, files }).files).toEqual(files);
    // a template read without them is still valid (the copy a team stores has none)
    expect(TeamTemplate.safeParse(ok).success).toBe(true);
  });

  it('refuses a file anywhere else, for a bot the template does not list, or empty', () => {
    const accepts = (path: string, text = 'x'): boolean => TeamTemplate.safeParse({ ...ok, files: { [path]: text } }).success;
    expect(accepts('bots/brain/BOT.md')).toBe(true);
    expect(accepts('bots/coder/BOT.md')).toBe(false); // not one of the template's bots
    expect(accepts('TEAM.md')).toBe(false);
    expect(accepts('pages/readme.md')).toBe(false);
    expect(accepts('bots/brain/memory.md')).toBe(false);
    expect(accepts('bots/brain/evals/../BOT.md')).toBe(false);
    expect(accepts('bots/brain/evals/a/b.yaml')).toBe(false);
    expect(accepts('bots/Brain/BOT.md')).toBe(false);
    expect(accepts('bots/brain/BOT.md', '')).toBe(false);
    const many = Object.fromEntries(Array.from({ length: TEMPLATE_FILES_MAX + 1 }, (_, i) => [`bots/brain/evals/s${i}.yaml`, 'x']));
    expect(TeamTemplate.safeParse({ ...ok, files: many }).success).toBe(false);
  });

  it('keeps the stored definition free of the bot files', () => {
    const withFiles = TeamTemplate.parse({ ...ok, files: { 'bots/brain/BOT.md': 'x' } });
    const stored = templateDefinitionOf(withFiles);
    expect('files' in stored).toBe(false);
    expect(TeamTemplate.parse(stored)).toEqual(ok);
  });
});
