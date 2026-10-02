import { describe, expect, it } from 'vitest';
import { markdownToPlain } from '../src/plain.ts';

describe('markdownToPlain', () => {
  it.each([
    ['**bold** and _italic_ and ~~gone~~', 'bold and italic and gone'],
    ['use `rollback` now', 'use rollback now'],
    ['```sh\nkubectl rollout undo\n```\nthen check', 'kubectl rollout undo then check'],
    ['see [the runbook](https://x.example/a?b=c) first', 'see the runbook first'],
    ['![diagram](https://x.example/d.png) after', 'diagram after'],
    ['# Heading\n> quoted\n- one\n- two\n1. three', 'Heading quoted one two three'],
    ['ask @nadia in #dev about [[Deploy plan]]', 'ask @nadia in #dev about Deploy plan'],
    ['a <b>tag</b> here', 'a tag here'],
    ['snake_case_name stays', 'snake_case_name stays'],
    ['2 * 3 = 6', '2 * 3 = 6'],
    ['', ''],
  ])('%j -> %j', (input, expected) => {
    expect(markdownToPlain(input)).toBe(expected);
  });

  it('is linear on hostile input', () => {
    const t = Date.now();
    markdownToPlain('['.repeat(20_000) + '`'.repeat(20_000) + '*'.repeat(20_000) + '<a'.repeat(10_000));
    expect(Date.now() - t).toBeLessThan(1_000);
  });
});
