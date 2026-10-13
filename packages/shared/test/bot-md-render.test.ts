import { expectLinear } from '../../test-utils/src/linear.ts';
import { describe, expect, it } from 'vitest';
import { BotFrontmatter } from '../src/bot-md/frontmatter.ts';
import { parseBotMd, renderBotMd, splitBotMd } from '../src/bot-md/render.ts';

// The BOT.md round trip (PLAN P5-05): the editor writes a file through `renderBotMd` and the loader reads it back through
// `parseBotMd`. They share this module precisely so a save can never produce a definition the loader would refuse — the red banner
// is then only ever about a definition that arrived some other way (a hand-written file, a pull request, a bad merge).

const SAMPLE = BotFrontmatter.parse({
  schema: 1,
  name: 'Coder',
  role: "Owns a task's branch",
  kind: 'agent',
  runtime: 'hermes',
  model: { aliases: ['code', 'fast'], effort: 'medium' },
  visibility: 'team',
  triggers: [{ type: 'conversation' }, { type: 'mention', source: { channels: ['#dev', '#releases'] } }],
  capabilities: {
    native: ['tasks.read', 'tasks.claim', 'messages.*', 'pages.write'],
    runtime: ['shell', 'files', 'git'],
    connections: [{ name: 'github-kahf', tools: ['github.read', 'github.pr.create'] }],
  },
  knowledge: [{ base: 'architecture-docs' }],
  memory: { file: 'memory.md', maxLines: 2000, grants: [{ bank: 'team:engineering', access: 'readwrite' }] },
  skills: ['git-hygiene'],
  guard: { preset: 'strict-egress', gate: ['credential rotation', 'delete production data'] },
  approvals: { needsApproval: ['github.pr.create'], approvers: ['role:on-call'] },
  handover: { mayTag: ['reviewer', 'tester'], toPerson: ['role:on-call'] },
  placement: { node: 'build-01', isolation: 'shared' },
  limits: { sessionMinutes: 45, hops: 3 },
  contract: { outputs: { sha: 'string', pr: 'url' } },
  evals: { set: 'coder-20', minScore: 0.9 },
});

const BODY = '# Coder — Engineering\n\nYou own a task until you hand it over.';

describe('renderBotMd', () => {
  it('writes the fence, the frontmatter and the prose, and the loader parses all of it back', () => {
    const file = renderBotMd(SAMPLE, BODY);
    expect(file.startsWith('---\n')).toBe(true);
    expect(file.endsWith(`${BODY}\n`)).toBe(true);
    const parsed = parseBotMd(file);
    expect(parsed.ok, parsed.ok ? '' : JSON.stringify(parsed.failure)).toBe(true);
    if (parsed.ok) expect(parsed.frontmatter).toEqual(SAMPLE);
  });

  it('is deterministic: rendering the parsed file again writes the same bytes', () => {
    const once = renderBotMd(SAMPLE, BODY);
    const parsed = parseBotMd(once);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(renderBotMd(parsed.frontmatter, splitBotMd(once).ok ? (splitBotMd(once) as { body: string }).body : '')).toBe(once);
  });

  it('leaves out what the definition did not set, rather than writing nulls and empty lists', () => {
    const minimal = BotFrontmatter.parse({ name: 'Brain', role: 'Answers', kind: 'agent', runtime: 'hermes' });
    const file = renderBotMd(minimal, 'Soul.');
    expect(file).not.toContain('null');
    expect(file).not.toMatch(/^(triggers|capabilities|model|guard|approvals|handover|placement|limits|contract|evals|skills|knowledge|memory|visibility):/m);
    expect(parseBotMd(file)).toMatchObject({ ok: true });
  });

  it('a role or name with characters YAML would read as syntax survives the round trip', () => {
    const tricky = BotFrontmatter.parse({
      name: 'Ops: on-call "first"',
      role: "Keeps #dev clean — and never says: 'yes' to a deploy",
      kind: 'automation',
      runtime: 'rules',
      guard: { gate: ['delete production data', '9 o\'clock: freeze'] },
    });
    const file = renderBotMd(tricky, 'Body with --- inside it\n\nAnd a fence-looking line.');
    const parsed = parseBotMd(file);
    expect(parsed.ok, parsed.ok ? '' : JSON.stringify(parsed.failure)).toBe(true);
    if (parsed.ok) expect(parsed.frontmatter).toEqual(tricky);
  });

  it('normalises the body: leading blank lines and trailing space go, the words stay', () => {
    const file = renderBotMd(SAMPLE, '\n\n\nSoul text.   \n\n');
    const split = splitBotMd(file);
    expect(split.ok).toBe(true);
    if (split.ok) expect(split.body).toBe('\nSoul text.\n');
  });
});
describe('hostile BOT.md input (parse is linear-time and bounded)', () => {
  const headers = '---\nschema: 1\nname: X\nrole: Y\nkind: agent\nruntime: hermes\n';

  it('a 1 MB file is refused at once, before it is split or parsed', () => {
    const res = parseBotMd(`${headers}---\n${'a'.repeat(1024 * 1024)}`);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.message).toMatch(/larger than 256 KB/);
    // "at once" is a shape, not a number of milliseconds: a file four times as large is refused in about the same time (the size is checked
    // before the file is split or parsed), and nowhere near a second
    expectLinear((n) => `${headers}---\n${'a'.repeat(n)}`, (text) => parseBotMd(text), { n: 1024 * 1024, factor: 4, label: 'a refused BOT.md' });
  });

  it('a file just under the cap is still read', () => {
    const res = parseBotMd(`${headers}---\n${'a'.repeat(200 * 1024)}`);
    expect(res.ok).toBe(true);
  });

  it('more aliases of one anchor than the cap is an invalid definition, though the library default (100) would accept it', () => {
    // `skills` is an allowed key of strings: one anchor and N aliases of it
    const skills = (n: number): string => `skills: [&s git-hygiene${Array(n).fill(', *s').join('')}]\n`;
    const started = performance.now();
    const over = parseBotMd(`${headers}${skills(60)}---\nbody\n`); // 60 > 20 (ours) but < 100 (yaml's default)
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.failure.message).toMatch(/alias/i);
    expect(performance.now() - started).toBeLessThan(1000);
    // within the cap the same shape gets past YAML: whatever the schema says about it, it is not about aliases
    const within = parseBotMd(`${headers}${skills(10)}---\nbody\n`);
    if (!within.ok) expect(within.failure.message).not.toMatch(/alias/i);
  });
});
