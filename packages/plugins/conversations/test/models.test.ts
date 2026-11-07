import { createHash } from 'node:crypto';
import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { describe, expect, it, vi } from 'vitest';
import { boundAliases, definitionAliases, menuOf } from '../src/models.ts';

// The model menu of the Chat screen, its pieces (PLAN P20-16, P20-T4): the words a person sees for an alias, which aliases the workspace has a model for, and the aliases
// of the definition the bot was loaded from. The route that joins them is tested in chat.test.ts; here the repository and the database are canned.

const bot = (sha: string) => ({ teamId: '00000000-0000-7000-8000-0000000b0001', slug: 'brain', definitionSha: sha });
const WS = '00000000-0000-7000-8000-00000000a001';

describe('menuOf', () => {
  it('names the aliases in plain words with a hint, the first as the default', () => {
    const menu = menuOf(['smart', 'fast', 'code', 'local', 'vision'], new Set(['smart', 'fast', 'code', 'local', 'vision']));
    expect(menu.map((m) => [m.alias, m.label, m.hint, m.isDefault])).toEqual([
      ['smart', 'Smart', 'Slower and more careful', true],
      ['fast', 'Fast', 'Quicker answers', false],
      ['code', 'Code', 'Tuned for programming', false],
      ['local', 'Private', 'Runs on this server', false],
      ['vision', 'Pictures', 'Can look at images', false],
    ]);
    expect(menu.every((m) => m.available && m.reason === null)).toBe(true);
  });

  it('marks the aliases the workspace has no model for, with a sentence that says what to do', () => {
    const menu = menuOf(['smart', 'fast'], new Set(['smart']));
    expect(menu[0]).toMatchObject({ alias: 'smart', available: true, reason: null });
    expect(menu[1]).toMatchObject({ alias: 'fast', available: false, reason: 'Fast has no model yet. Ask an admin to set it up on the LLM page.' });
  });

  it('shows no provider or model name, whatever the alias', () => {
    const text = JSON.stringify(menuOf(['smart', 'fast', 'embed'], new Set()));
    expect(text).not.toMatch(/gpt|claude|openai|anthropic|litellm|test-model/i);
  });

  it('writes an alias it has no words for with a capital letter and no hint', () => {
    expect(menuOf(['embed'], new Set())[0]).toMatchObject({ alias: 'embed', label: 'Embed', hint: '', available: false });
  });

  it('is an empty menu for a definition that lists no alias', () => {
    expect(menuOf([], new Set())).toEqual([]);
  });

  it('keeps the order of the definition and makes only the first the default, even when it is not bound', () => {
    const menu = menuOf(['fast', 'smart'], new Set(['smart']));
    expect(menu.map((m) => m.alias)).toEqual(['fast', 'smart']);
    expect(menu.map((m) => m.isDefault)).toEqual([true, false]);
    expect(menu[0]?.available).toBe(false);
  });
});

describe('boundAliases', () => {
  const ctxOf = (rows: Array<{ t: string | null } | { alias: string }>[]): { ctx: PluginContext; system: ReturnType<typeof vi.fn>; queries: Array<{ sql: string; params: unknown[] | undefined }> } => {
    const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];
    let i = 0;
    const tx = { query: async (sql: string, params?: unknown[]) => { queries.push({ sql, params }); return { rows: rows[i++] ?? [] }; } } as unknown as PluginTx;
    const system = vi.fn(async (fn: (t: PluginTx) => Promise<unknown>) => fn(tx));
    return { ctx: { db: { system } } as unknown as PluginContext, system, queries };
  };

  it('asks nothing when no alias is wanted', async () => {
    const { ctx, system } = ctxOf([]);
    expect(await boundAliases(ctx, WS, [])).toEqual(new Set());
    expect(system).not.toHaveBeenCalled();
  });

  it('reads the workspace’s aliases as the system role scoped to that workspace', async () => {
    const { ctx, system, queries } = ctxOf([[{ t: 'app.llm_aliases' }], [{ alias: 'smart' }]]);
    expect(await boundAliases(ctx, WS, ['smart', 'fast'])).toEqual(new Set(['smart']));
    expect(system.mock.calls[0]?.[1]).toEqual({ workspaceId: WS });
    expect(queries[1]?.params).toEqual([WS, ['smart', 'fast']]);
  });

  it('is an empty set where the LLM page has no table yet (every model greyed, none broken)', async () => {
    const { ctx, queries } = ctxOf([[{ t: null }]]);
    expect(await boundAliases(ctx, WS, ['smart'])).toEqual(new Set());
    expect(queries).toHaveLength(1);
  });
});

describe('definitionAliases', () => {
  const md = (aliases: string): string =>
    ['---', 'schema: 1', 'name: Brain', 'role: Answers', 'kind: agent', 'runtime: hermes', 'model:', `  aliases: ${aliases}`, 'triggers:', '  - { type: conversation }', 'capabilities:', '  native: [messages.post]', '---', '', '# Brain', '', 'Soul.', ''].join('\n');
  const shaOf = (text: string): string => createHash('sha256').update(Buffer.from(text)).digest('hex');

  function rig(blob: () => Promise<{ content: Uint8Array }> | { content: Uint8Array }, withRepo = true): { ctx: PluginContext; tx: PluginTx; sql: string[] } {
    const sql: string[] = [];
    const tx = { query: async (s: string) => { sql.push(s); return { rows: [] }; } } as unknown as PluginTx;
    const ctx = { providers: { get: () => (withRepo ? { blob: async () => blob() } : undefined) } } as unknown as PluginContext;
    return { ctx, tx, sql };
  }

  it('reads the aliases of the file the roster row was loaded from', async () => {
    const text = md('[smart, fast, code]');
    const { ctx, tx, sql } = rig(() => ({ content: Buffer.from(text) }));
    expect(await definitionAliases(ctx, tx, bot(shaOf(text)))).toEqual(['smart', 'fast', 'code']);
    expect(sql).toEqual(['SAVEPOINT conversation_models', 'RELEASE SAVEPOINT conversation_models']);
  });

  it('answers null when the file on the branch is no longer the one that was loaded (the caller asks again later)', async () => {
    const { ctx, tx } = rig(() => ({ content: Buffer.from(md('[smart]')) }));
    expect(await definitionAliases(ctx, tx, bot(shaOf(md('[smart, fast]'))))).toBeNull();
  });

  it('answers null for a file that is not a valid definition', async () => {
    const text = 'not a bot definition';
    const { ctx, tx } = rig(() => ({ content: Buffer.from(text) }));
    expect(await definitionAliases(ctx, tx, bot(shaOf(text)))).toBeNull();
  });

  it('answers an empty list for a definition that names no model', async () => {
    const text = md('[]').replace(/model:\n {2}aliases: \[\]\n/, '');
    const { ctx, tx } = rig(() => ({ content: Buffer.from(text) }));
    expect(await definitionAliases(ctx, tx, bot(shaOf(text)))).toEqual([]);
  });

  it('answers null without a repository provider', async () => {
    const { ctx, tx, sql } = rig(() => ({ content: Buffer.from('') }), false);
    expect(await definitionAliases(ctx, tx, bot('x'))).toBeNull();
    expect(sql).toEqual([]);
  });

  it('answers null and gives the transaction back whole when the repository cannot read the file', async () => {
    const { ctx, tx, sql } = rig(() => { throw new Error('no such file'); });
    expect(await definitionAliases(ctx, tx, bot('x'))).toBeNull();
    expect(sql).toEqual(['SAVEPOINT conversation_models', 'ROLLBACK TO SAVEPOINT conversation_models', 'RELEASE SAVEPOINT conversation_models']);
  });
});
