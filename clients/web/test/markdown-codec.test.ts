import { describe, expect, it } from 'vitest';
import { bodyToDoc, docToText, parseMarkdown, serializeMarkdown, tidyMarkdown } from '../src/viewers/markdown/codec';

/** Markdown the editor writes itself: reading it and writing it back must give the same bytes. */
const CANONICAL: Record<string, string> = {
  headings: '# One\n\n## Two\n\n### Three\n',
  paragraph: 'A paragraph with **bold**, *italic*, ~~strike~~, `code` and a [link](https://example.com/a?b=1).\n',
  'two paragraphs': 'First.\n\nSecond.\n',
  bullets: '- a\n- b\n  - nested\n- c\n',
  ordered: '1. one\n2. two\n3. three\n',
  tasks: '- [ ] todo\n- [x] done\n',
  quote: '> quoted\n>\n> two paragraphs\n',
  fence: '```ts\nconst x = 1;\nif (x) {\n\n  go();\n}\n```\n',
  rule: 'Above.\n\n---\n\nBelow.\n',
  table: '| week    | signups | churn |\n| ------- | ------- | ----- |\n| 2026-W36 | 410 | 1.2% |\n',
  image: 'Look: ![diagram](pages/img/arch.png)\n',
};

describe('markdown codec', () => {
  for (const [name, md] of Object.entries(CANONICAL)) {
    it(`round-trips ${name} semantically and then byte-for-byte`, () => {
      const once = serializeMarkdown(parseMarkdown(md));
      // the first write may normalise spacing (table padding) but never loses content
      expect(parseMarkdown(once)).toEqual(parseMarkdown(md));
      // after that it is a fixed point: opening and saving again changes nothing
      expect(serializeMarkdown(parseMarkdown(once))).toBe(once);
    });
  }

  it('keeps common syntax variants meaning the same thing', () => {
    const variants = [
      '* a\n* b\n',
      '__bold__ and _italic_\n',
      'Setext\n======\n\ntext\n',
      '1) one\n2) two\n',
      '***\n',
      '    indented code\n',
      'line one  \nline two\n',
    ];
    for (const v of variants) {
      const once = serializeMarkdown(parseMarkdown(v));
      expect(parseMarkdown(once), v).toEqual(parseMarkdown(v));
    }
  });

  it('writes plain, regular documents exactly as they were', () => {
    const doc = '# Week 37\n\nSessions held steady.\n\n- one\n- two\n\n```json\n{"a": 1}\n```\n';
    expect(serializeMarkdown(parseMarkdown(doc))).toBe(doc);
  });

  it('collapses blank-line runs outside code fences and not inside them', () => {
    expect(tidyMarkdown('a\n\n\n\nb\n\n\n')).toBe('a\n\nb\n');
    expect(tidyMarkdown('```\na\n\n\nb\n```\n\n\nz\n')).toBe('```\na\n\n\nb\n```\n\nz\n');
  });

  it('keeps the frontmatter block verbatim', () => {
    const text = '---\ntitle: "Week 37"\ntags: [a,   b]\n---\n\n# Hello\n\nBody.\n';
    const { frontmatter, doc } = bodyToDoc(text);
    expect(frontmatter).toBe('---\ntitle: "Week 37"\ntags: [a,   b]\n---\n');
    const again = docToText(frontmatter, doc);
    expect(again.startsWith(frontmatter)).toBe(true);
    expect(parseMarkdown(again.slice(frontmatter.length))).toEqual(parseMarkdown('# Hello\n\nBody.\n'));
  });

  it('an empty document stays empty', () => {
    expect(serializeMarkdown(parseMarkdown(''))).toBe('');
  });

  it('survives hostile input in a bounded time (the parser is marked: emphasis runs are quadratic, so the viewer opens big files raw)', () => {
    const hostile = '['.repeat(20000) + '*a '.repeat(1500) + '`'.repeat(5000);
    const t = Date.now();
    serializeMarkdown(parseMarkdown(hostile));
    expect(Date.now() - t).toBeLessThan(2000);
  });
});
