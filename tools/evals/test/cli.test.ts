import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findBotFolders, runEvalCli } from '../src/run.ts';

// `pnpm test:evals -- --bot=<slug>` (PLAN P7-08): exit 0 at or above the minimum, 1 below it, 2 when the files cannot be used.

const botMd = (native: string, minScore: number): string =>
  `---\nschema: 1\nname: Demo\nrole: Demo\nkind: agent\nruntime: hermes\ntriggers:\n  - type: mention\ncapabilities:\n  native: [${native}]\nevals:\n  set: qa\n  minScore: ${minScore}\n---\n\n# Demo\n\nBody.\n`;
const set = `schema: 1\nset: qa\ncases:\n  - id: posts\n    question: Q?\n    expect:\n      toolCalls:\n        required: [answer.post]\n    rationale: It has to post.\n`;

async function folder(md: string | null, setText: string | null): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'evals-cli-'));
  await mkdir(join(root, 'bots', 'demo', 'evals'), { recursive: true });
  if (md !== null) await writeFile(join(root, 'bots', 'demo', 'BOT.md'), md);
  if (setText !== null) await writeFile(join(root, 'bots', 'demo', 'evals', 'qa.yaml'), setText);
  return root;
}
const run = async (argv: string[], cwd: string): Promise<{ code: number; out: string; err: string }> => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runEvalCli(argv, { out: (l) => out.push(l), err: (l) => err.push(l), cwd });
  return { code, out: out.join('\n'), err: err.join('\n') };
};

describe('pnpm test:evals', () => {
  it('exits 0 for a bot at its minimum', async () => {
    const root = await folder(botMd('answer.post', 1), set);
    const r = await run(['--bot=demo'], root);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/1 of 1/);
  });

  it('exits 1 below the minimum and names the case and the reason', async () => {
    const root = await folder(botMd('messages.post', 1), set);
    const r = await run(['--bot=demo'], root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('posts');
    expect(r.out).toContain('answer.post');
  });

  it('exits 2, in plain words, for a missing set file, an unknown bot and a bad name', async () => {
    const noSet = await run(['--bot=demo'], await folder(botMd('answer.post', 1), null));
    expect(noSet.code).toBe(2);
    expect(noSet.err + noSet.out).toContain('qa.yaml');
    const unknown = await run(['--bot=nobody'], await folder(botMd('answer.post', 1), set));
    expect(unknown.code).toBe(2);
    expect((await run(['--bot=Bad Name'], await folder(null, null))).code).toBe(2);
    expect((await run([], await folder(null, null))).code).toBe(2);
  });

  it('finds the bot in a template when the folder itself has none, and takes --root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evals-cli-'));
    await mkdir(join(root, 'templates', 'one', 'bots', 'demo', 'evals'), { recursive: true });
    await writeFile(join(root, 'templates', 'one', 'bots', 'demo', 'BOT.md'), botMd('answer.post', 1));
    await writeFile(join(root, 'templates', 'one', 'bots', 'demo', 'evals', 'qa.yaml'), set);
    expect(await findBotFolders('demo', root)).toEqual([join(root, 'templates', 'one')]);
    expect((await run(['--bot=demo'], root)).code).toBe(0);
    expect((await run(['--bot=demo', `--root=${join(root, 'templates', 'one')}`], tmpdir())).code).toBe(0);
  });
});
