import { describe, expect, it } from 'vitest';
import { pathTokenLength, repairBotMarkdown } from '../src/text/paths.ts';

const found = (s: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i < s.length; ) {
    const n = pathTokenLength(s, i);
    if (n > 0) {
      out.push(s.slice(i, i + n));
      i += n;
    } else i += 1;
  }
  return out;
};

describe('pathTokenLength', () => {
  it('finds files and paths in prose, without the sentence punctuation after them', () => {
    expect(found('Edit TEAM.md and bots/coder/BOT.md, then run e2e/chat/switcher.spec.ts.')).toEqual(['TEAM.md', 'bots/coder/BOT.md', 'e2e/chat/switcher.spec.ts']);
    expect(found('see (package.json) and ./scripts/run.sh or ~/notes/todo.txt')).toEqual(['package.json', './scripts/run.sh', '~/notes/todo.txt']);
    expect(found('the route /api/teams/engineering/projects answers')).toEqual(['/api/teams/engineering/projects']);
    expect(found('open packages/shared and deploy/helm')).toEqual(['packages/shared', 'deploy/helm']);
  });
  it('leaves ordinary prose alone', () => {
    expect(found('and/or yes/no w/o 2026/10/28 1/2 e.g. i.e. v1.2.3 kahf.to')).toEqual([]);
    expect(found('mail omar@kahf.example, tag @engineer, see #dev')).toEqual([]);
    expect(found('https://github.com/acme/widgets.git and test.manythreads.kahf.to/x')).toEqual([]);
  });
  it('is linear on hostile input', () => {
    const hostile = 'a/'.repeat(50_000) + 'b.'.repeat(50_000) + '/'.repeat(50_000);
    const t = performance.now();
    pathTokenLength(hostile, 0);
    repairBotMarkdown(hostile);
    expect(performance.now() - t).toBeLessThan(1_500);
  });
});

describe('repairBotMarkdown', () => {
  it('wraps bare paths in backticks and leaves code, links and addresses as written', () => {
    const src = ['Changed TEAM.md and `bots/x/BOT.md`.', 'See [the doc](docs/plan.md) and https://example.com/a/b.html.', '```', 'cat TEAM.md', '```'].join('\n');
    const r = repairBotMarkdown(src);
    expect(r.text).toBe(['Changed `TEAM.md` and `bots/x/BOT.md`.', 'See [the doc](docs/plan.md) and https://example.com/a/b.html.', '```', 'cat TEAM.md', '```'].join('\n'));
    expect(r).toMatchObject({ paths: 1, fences: 0 });
  });
  it('closes a fence that was left open', () => {
    const r = repairBotMarkdown('Run:\n```bash\npnpm lint');
    expect(r.text).toBe('Run:\n```bash\npnpm lint\n```');
    expect(r.fences).toBe(1);
  });
  it('changes nothing when there is nothing to repair', () => {
    const src = 'All `TEAM.md` good\n\n- [x] one\n- [ ] two';
    expect(repairBotMarkdown(src)).toEqual({ text: src, paths: 0, fences: 0 });
  });
});
