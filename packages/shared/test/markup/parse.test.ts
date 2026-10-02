import { describe, expect, it } from 'vitest';
import { MarkupParseResult, parseMarkup } from '../../src/index.ts';

const U1 = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const U2 = '0190A1B2-C3D4-7E5F-8A9B-0C1D2E3F4A5C';

const handles = (md: string, bots: string[] = []) => parseMarkup(md, { botHandles: bots }).mentions.map((m) => `${m.kind}:${m.handle}`);
const channels = (md: string) => parseMarkup(md).channels.map((c) => c.name);
const h = (s: string): string => s.replaceAll('~', '#'); // keeps hex-looking `#123` out of the colour lint
const refs = (md: string) => parseMarkup(md).entityRefs.map((r) => `${r.type}:${r.id}`);

describe('mentions', () => {
  it('finds a person and reports exact spans', () => {
    const md = 'hello @omar!';
    const r = parseMarkup(md);
    expect(r.mentions).toEqual([{ kind: 'person', handle: 'omar', start: 6, end: 11 }]);
    expect(md.slice(6, 11)).toBe('@omar');
  });

  it('marks handles the caller says are bots, case-insensitively', () => {
    expect(handles('@Coder please ask @nadia', ['coder'])).toEqual(['bot:Coder', 'person:nadia']);
  });

  it('accepts dots, hyphens and underscores inside, not at the end', () => {
    expect(handles('@first.last @a-b @snake_case')).toEqual(['person:first.last', 'person:a-b', 'person:snake_case']);
    expect(handles('@omar. @omar, @omar- @omar_ @omar; @omar? (@omar)')).toEqual(Array(7).fill('person:omar'));
  });

  it('keeps the span free of trailing punctuation', () => {
    const md = 'cc @omar.';
    const [m] = parseMarkup(md).mentions;
    expect(md.slice(m!.start, m!.end)).toBe('@omar');
  });

  it('handles unicode names', () => {
    expect(handles('@جميل and @zoë and @名前 and @Ünal')).toEqual(['person:جميل', 'person:zoë', 'person:名前', 'person:Ünal']);
  });

  it('uses UTF-16 offsets after astral characters', () => {
    const md = '😀 @omar';
    const [m] = parseMarkup(md).mentions;
    expect(md.slice(m!.start, m!.end)).toBe('@omar');
  });

  it('ignores email addresses', () => {
    expect(handles('mail omar@kahf.co or <nadia@kahf.co> or a.b+c@x.org')).toEqual([]);
    expect(handles('omar@kahf.co @omar')).toEqual(['person:omar']);
  });

  it('ignores a lone @, @ before punctuation and escaped mentions', () => {
    expect(handles('@ @@omar @-x @.x \\@omar')).toEqual([]);
  });

  it('ignores scoped packages and paths', () => {
    expect(handles('npm i @manythreads/shared and /@omar and a/@b')).toEqual([]);
  });

  it('ignores mentions inside URLs and link destinations', () => {
    expect(handles('see https://example.com/@omar and www.x.com/@nadia')).toEqual([]);
    expect(handles('[profile](https://x.com/@omar) @priya')).toEqual(['person:priya']);
    expect(handles('[x](/people/@omar "@title")')).toEqual([]);
    expect(handles('<https://x.com/@omar>')).toEqual([]);
  });

  it('keeps a mention that follows a URL', () => {
    expect(handles('https://x.com. @omar')).toEqual(['person:omar']);
    expect(handles('(https://x.com/a) @omar')).toEqual(['person:omar']);
  });

  it('parses a mention in link text', () => {
    expect(handles('[@omar](https://x.com)')).toEqual(['person:omar']);
  });

  it('ignores names longer than 64 characters', () => {
    expect(handles(`@${'a'.repeat(65)}`)).toEqual([]);
    expect(handles(`@${'a'.repeat(64)}`)).toHaveLength(1);
  });

  it('parses adjacent and repeated mentions', () => {
    expect(handles('@omar,@nadia @omar')).toEqual(['person:omar', 'person:nadia', 'person:omar']);
    expect(handles('(@omar)(@nadia)')).toEqual(['person:omar', 'person:nadia']);
    expect(handles('**@omar** _@nadia_ ~~@priya~~')).toEqual(['person:omar', 'person:nadia', 'person:priya']);
    expect(handles('> @omar\n- @nadia\n# @priya')).toEqual(['person:omar', 'person:nadia', 'person:priya']);
  });

  it('does not glue handles written without a separator', () => {
    expect(handles('@omar@nadia')).toEqual([]);
  });
});

describe('channels', () => {
  it('finds channel names with spans', () => {
    const md = 'post in #releases, not #dev.';
    const r = parseMarkup(md);
    expect(r.channels.map((c) => c.name)).toEqual(['releases', 'dev']);
    expect(md.slice(r.channels[0]!.start, r.channels[0]!.end)).toBe('#releases');
  });

  it('accepts hyphens, underscores, digits and unicode', () => {
    expect(channels(h('#q3-plans #team_x ~2024-goals #النشر #проект'))).toEqual(['q3-plans', 'team_x', '2024-goals', 'النشر', 'проект']);
  });

  it('is not a markdown heading or an issue number', () => {
    expect(channels(h('# Title\n## Sub\n~123 and ~1'))).toEqual([]);
    expect(channels('#general at the start')).toEqual(['general']);
  });

  it('ignores anchors, entities and glued hashes', () => {
    expect(channels(h('page.html#section a#b &~169; ##tag'))).toEqual([]);
    expect(channels('https://x.com/p#frag [t](/p#frag)')).toEqual([]);
    expect(channels('\\#general')).toEqual([]);
    expect(channels('C# and F#')).toEqual([]);
  });

  it('keeps case as typed and trims trailing punctuation', () => {
    expect(channels('#General, (#Dev-ops)! #x-')).toEqual(['General', 'Dev-ops', 'x']);
  });

  it('does not take a channel out of a mention', () => {
    const r = parseMarkup('@omar#general');
    expect(r.mentions).toHaveLength(1);
    expect(r.channels).toEqual([]);
  });

  it('parses adjacent channels separated by space or comma', () => {
    expect(channels('#a-1 #b-2,#c-3 (#d-4)')).toEqual(['a-1', 'b-2', 'c-3', 'd-4']);
  });
});

describe('entity references', () => {
  it('parses each type', () => {
    expect(refs(`[[thread:${U1}]] [[file:${U2}]] [[page:notes/plan.md]] [[task:T-42]]`)).toEqual([
      `thread:${U1}`,
      `file:${U2.toLowerCase()}`,
      'page:notes/plan.md',
      'task:T-42',
    ]);
  });

  it('reports spans of the whole [[...]]', () => {
    const md = `see [[task:42]] ok`;
    const [r] = parseMarkup(md).entityRefs;
    expect(md.slice(r!.start, r!.end)).toBe('[[task:42]]');
  });

  it('accepts a uuid task id', () => {
    expect(refs(`[[task:${U1}]]`)).toEqual([`task:${U1}`]);
  });

  it('rejects malformed refs', () => {
    expect(refs('[[thread:nope]] [[file:123]] [[task:]] [[task:a b]] [[page:]] [[unknown:x]] [[thread]] [[x]]')).toEqual([]);
    expect(refs(`[[thread:${U1}`)).toEqual([]);
    expect(refs(`[thread:${U1}]`)).toEqual([]);
    expect(refs(`\\[[thread:${U1}]]`)).toEqual([]);
  });

  it('rejects page paths that climb or are malformed', () => {
    expect(refs('[[page:../secret]] [[page:a/../b]] [[page:a//b]] [[page:./a]] [[page:a\\b]]')).toEqual([]);
  });

  it('trims and normalises a page path, allows spaces and unicode', () => {
    expect(refs('[[page: /notes/my plan.md ]] [[page:ملاحظات/خطة.md]]')).toEqual(['page:notes/my plan.md', 'page:ملاحظات/خطة.md']);
  });

  it('parses adjacent refs and refs next to other tokens', () => {
    expect(refs('[[task:1]][[task:2]]')).toEqual(['task:1', 'task:2']);
    const r = parseMarkup('[[task:1]]@omar#ship-it');
    expect(r.mentions).toHaveLength(1);
    expect(r.entityRefs).toHaveLength(1);
  });

  it('does not read mentions or channels inside a valid ref, but does inside an invalid one', () => {
    expect(handles('[[page:a b/@omar]]')).toEqual([]);
    expect(channels('[[page:team notes/#general]]')).toEqual([]);
    expect(handles('[[nope @omar]]')).toEqual(['person:omar']);
  });
});

describe('code, URLs and escapes are inert', () => {
  const md = (body: string) => parseMarkup(body);

  it('ignores inline code', () => {
    const r = md('`@omar #general [[task:1]]` and @nadia');
    expect(r.mentions.map((m) => m.handle)).toEqual(['nadia']);
    expect(r.channels).toEqual([]);
    expect(r.entityRefs).toEqual([]);
  });

  it('supports longer backtick runs and a backtick inside', () => {
    expect(handles('``a ` @omar`` @nadia')).toEqual(['person:nadia']);
    expect(handles('```@omar``` @nadia')).toEqual(['person:nadia']);
  });

  it('treats an unmatched backtick as text', () => {
    expect(handles('a ` @omar')).toEqual(['person:omar']);
    expect(handles('`@omar``')).toEqual(['person:omar']);
  });

  it('does not let a code span cross a blank line', () => {
    expect(handles('`a\n\n@omar`')).toEqual(['person:omar']);
  });

  it('lets a code span cross a single newline', () => {
    expect(handles('`a\n@omar` @nadia')).toEqual(['person:nadia']);
  });

  it('treats an escaped backtick as text', () => {
    expect(handles('\\`@omar`')).toEqual(['person:omar']);
  });

  it('ignores fenced blocks, with info string and tildes', () => {
    expect(handles('```ts\nconst x = "@omar"\n```\n@nadia')).toEqual(['person:nadia']);
    expect(handles('~~~\n@omar\n~~~\n@nadia')).toEqual(['person:nadia']);
  });

  it('needs a fence at least as long to close', () => {
    expect(handles('````\n```\n@omar\n```\n````\n@nadia')).toEqual(['person:nadia']);
  });

  it('runs an unclosed fence to the end', () => {
    expect(handles('```\n@omar\n@nadia')).toEqual([]);
  });

  it('ignores a fence inside a quote or list', () => {
    expect(handles('> ```\n> @omar\n> ```\n@nadia')).toEqual(['person:nadia']);
    expect(handles('- item\n  ```\n  @omar\n  ```\n- @nadia')).toEqual(['person:nadia']);
  });

  it('reads text right after a fence', () => {
    expect(channels('```\nx\n```\n#general')).toEqual(['general']);
  });

  it('handles CRLF', () => {
    expect(handles('```\r\n@omar\r\n```\r\n@nadia')).toEqual(['person:nadia']);
  });
});

describe('tokens', () => {
  it('tile the whole input in order', () => {
    const body = `Hi @omar, see #releases and [[task:7]] \`@x\`\n\`\`\`\ncode @y\n\`\`\`\nhttps://a.b/@c end`;
    const { tokens } = parseMarkup(body);
    let at = 0;
    for (const t of tokens) {
      expect(t.start).toBe(at);
      expect(t.end).toBeGreaterThan(t.start);
      at = t.end;
    }
    expect(at).toBe(body.length);
    expect(tokens.map((t) => t.type)).toEqual([
      'text',
      'mention',
      'text',
      'channel',
      'text',
      'entity_ref',
      'text',
      'code_span',
      'text',
      'code_block',
      'text',
      'url',
      'text',
    ]);
  });

  it('is one text token for plain input and none for empty input', () => {
    expect(parseMarkup('nothing here').tokens).toEqual([{ type: 'text', start: 0, end: 12 }]);
    expect(parseMarkup('')).toEqual({ tokens: [], mentions: [], channels: [], entityRefs: [] });
  });

  it('keeps URL punctuation out of the url token', () => {
    const body = 'go to https://x.com/a. Then (see https://x.com/b).';
    const urls = parseMarkup(body).tokens.filter((t) => t.type === 'url').map((t) => body.slice(t.start, t.end));
    expect(urls).toEqual(['https://x.com/a', 'https://x.com/b']);
  });
});

describe('MarkupParseResult', () => {
  it('validates what parseMarkup returns', () => {
    const r = parseMarkup(`@omar #releases [[thread:${U1}]] \`x\``, { botHandles: ['omar'] });
    expect(MarkupParseResult.parse(r)).toEqual(r);
  });

  it('rejects a bad kind and a bad entity type', () => {
    expect(MarkupParseResult.safeParse({ tokens: [], mentions: [{ kind: 'team', handle: 'x', start: 0, end: 2 }], channels: [], entityRefs: [] }).success).toBe(false);
    expect(MarkupParseResult.safeParse({ tokens: [], mentions: [], channels: [], entityRefs: [{ type: 'board', id: 'x', start: 0, end: 2 }] }).success).toBe(false);
  });

  it('never throws on awkward input', () => {
    for (const s of ['`', '```', '[[', ']]', '@', '#', '\\', '[](', '[x](', '', '\u0000@x', '@‍', '[[page:\n]]']) {
      expect(() => parseMarkup(s)).not.toThrow();
    }
  });
});

describe('hostile input (claims are checked with sorted-interval sweeps, not against every earlier claim)', () => {
  const MAX = 40_000; // the cap on a message body
  const timeIt = (md: string): number => {
    parseMarkup(md); // warm up the regexes
    return Math.min(
      ...Array.from({ length: 3 }, () => {
        const start = performance.now();
        parseMarkup(md);
        return performance.now() - start;
      }),
    );
  };

  it('13,000 mentions parse in under 30 ms and every one is found', () => {
    const md = '@a '.repeat(13_000);
    expect(md.length).toBeLessThanOrEqual(MAX);
    expect(parseMarkup(md).mentions).toHaveLength(13_000);
    expect(timeIt(md)).toBeLessThan(30);
  });

  it('13,000 channel references, 10,000 code spans, 8,000 URLs and a mix of all stay as fast', () => {
    const cases = ['#a '.repeat(13_000), '`@x` '.repeat(8_000), 'http://x.y/@z '.repeat(2_800), '[[page:a]]@a #b `c` http://q '.repeat(1_300)];
    for (const md of cases) {
      expect(md.length).toBeLessThanOrEqual(MAX);
      expect(timeIt(md), md.slice(0, 20)).toBeLessThan(60);
    }
  });

  it('keeps the first claim on an overlap: a mention inside a code span, URL or link destination is not a mention', () => {
    const r = parseMarkup('`@in` @out [x](http://a/@b) http://c/@d @out2');
    expect(r.mentions.map((m) => m.handle)).toEqual(['out', 'out2']);
  });
});
