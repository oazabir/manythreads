import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '../src/channels/MessageMarkdown';
import { MAX_RENDER_CHARS, cleanText, parseMarkdown } from '../src/channels/markdown';

/*
 * The safe zone. A message is text from a person or a bot, and either may be hostile. The renderer builds React elements from a tree it read itself, never
 * HTML, so these tests pin what that means: whatever the text, the page gets only these tags and only these attributes, and no link goes anywhere but
 * http, https, mailto or a path of this site.
 */

const html = (source: string): string => renderToStaticMarkup(createElement(Markdown, { source }));

const TAGS = new Set(['div', 'p', 'span', 'a', 'code', 'pre', 'strong', 'em', 'del', 'br', 'ul', 'ol', 'li', 'blockquote', 'input', 'button']);
const ATTRS = new Set([
  'class', 'href', 'title', 'target', 'rel', 'referrerpolicy', 'tabindex', 'type', 'checked', 'disabled', 'aria-label', 'data-testid', 'data-lang', 'data-level',
  'data-mention', 'data-checked', 'data-spoof',
]);

/** Every tag and attribute the markup uses, and every link target. */
function inspect(markup: string): { tags: Set<string>; attrs: Set<string>; hrefs: string[] } {
  const tags = new Set<string>();
  const attrs = new Set<string>();
  const hrefs: string[] = [];
  for (const m of markup.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*\/?>/g)) {
    tags.add((m[1] ?? '').toLowerCase());
    for (const a of (m[2] ?? '').matchAll(/\s+([^\s=>/]+)(?:="([^"]*)")?/g)) {
      attrs.add((a[1] ?? '').toLowerCase());
      if (a[1] === 'href') hrefs.push(a[2] ?? '');
    }
  }
  return { tags, attrs, hrefs };
}

const decode = (s: string): string => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'");

function expectSafe(source: string): void {
  const markup = html(source);
  const { tags, attrs, hrefs } = inspect(markup);
  for (const t of tags) expect(TAGS.has(t), `tag <${t}> from: ${source.slice(0, 60)}`).toBe(true);
  for (const a of attrs) expect(ATTRS.has(a), `attribute ${a} from: ${source.slice(0, 60)}`).toBe(true);
  for (const h of hrefs) {
    const href = decode(h);
    expect(/^(https?:\/\/|mailto:|\/(?![/\\]))/i.test(href), `href ${href} from: ${source.slice(0, 60)}`).toBe(true);
  }
  // no text node can carry markup: every `<` that is not a tag of ours is escaped
  expect(markup.replace(/<\/?[a-z][^>]*>/g, '')).not.toMatch(/[<>]/);
}

const ATTACKS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<a href="javascript:alert(1)">x</a>',
  '<style>body{display:none}</style>',
  '<meta http-equiv="refresh" content="0;url=https://evil.example">',
  '<base href="https://evil.example/">',
  '<form action="https://evil.example"><input name=password></form>',
  '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
  '[x](javascript:alert(1))',
  '[x](JaVaScRiPt:alert(1))',
  '[x](java\tscript:alert(1))',
  '[x](java&#x09;script:alert(1))',
  `[x](${String.fromCharCode(38, 35)}106;avascript:alert(1))`,
  '[x](%6Aavascript:alert(1))',
  '[x]( javascript:alert(1))',
  '[x](<javascript:alert(1)>)',
  '[x](data:text/html,<script>alert(1)</script>)',
  '[x](vbscript:msgbox(1))',
  '[x](file:///etc/passwd)',
  '[x](//evil.example/x)',
  '[x](/\\evil.example)',
  '[x]: javascript:alert(1)\n\n[x]',
  '<javascript:alert(1)>',
  'https://example.com/"onmouseover="alert(1)',
  "https://example.com/'onfocus='alert(1)",
  '![x](https://evil.example/pixel.gif)',
  '![x](javascript:alert(1))',
  '`</code><script>alert(1)</script>`',
  '```"><script>alert(1)</script>\ncode\n```',
  '```js onclick=alert(1)\ncode\n```',
  '@"><script>alert(1)</script>',
  '#"><img src=x onerror=alert(1)>',
  '> <script>alert(1)</script>',
  '- <script>alert(1)</script>',
  '# <script>alert(1)</script>',
  '[<img src=x onerror=alert(1)>](https://example.com)',
  '[x](https://example.com" onclick="alert(1))',
  '‮exe.txt',
  'a'.repeat(20_000),
];

describe('the safe zone', () => {
  it.each(ATTACKS)('draws only our own tags and attributes: %s', (attack) => {
    expectSafe(attack);
  });

  it('draws only our own tags and attributes for random hostile text', () => {
    const alphabet = ['<', '>', '"', "'", '`', '&', ';', ':', '(', ')', '[', ']', '*', '_', '~', '#', '@', '\n', ' ', '-', '/', '\\', '!', 'javascript:', 'script', 'onerror=', 'https://', 'x', '1', '\t', '‮'];
    let seed = 12345;
    const rand = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let run = 0; run < 1_500; run += 1) {
      let text = '';
      for (let i = 0, n = 5 + Math.floor(rand() * 60); i < n; i += 1) text += alphabet[Math.floor(rand() * alphabet.length)] ?? '';
      expectSafe(text);
    }
  });

  it('opens an outside link without giving the page away, and shows where a link that names another place really goes', () => {
    const plainLink = html('[docs](https://example.com/a)');
    expect(plainLink).toContain('rel="noopener noreferrer nofollow"');
    expect(plainLink).toContain('referrerPolicy="no-referrer"');
    expect(plainLink).not.toContain('data-spoof');
    const spoof = html('[https://bank.example/login](https://evil.example/steal)');
    expect(spoof).toContain('data-spoof="true"');
    expect(spoof).toContain('(evil.example)');
    // the same site, with or without www or a subpath, is no spoof
    expect(html('[example.com](https://www.example.com/x)')).not.toContain('data-spoof');
  });

  it('removes the characters that reorder or hide text', () => {
    expect(cleanText('safe‮txt.exe⁦x⁩\u0000\u0007﻿ y')).toBe('safetxt.exexy');
    expect(cleanText('line\nnext\ttab 😀‍👩')).toBe('line\nnext\ttab 😀‍👩');
    expect(html('a‮b')).not.toContain('‮');
  });

  it('cuts a huge message instead of building a huge page', () => {
    const huge = 'word '.repeat(60_000);
    const blocks = parseMarkdown(huge);
    expect(JSON.stringify(blocks).length).toBeLessThan(MAX_RENDER_CHARS * 2);
    const many = Array.from({ length: 5_000 }, (_, i) => `paragraph ${i}`).join('\n\n');
    expect(parseMarkdown(many).length).toBeLessThanOrEqual(601);
    expect(html(many)).toContain('the rest of this message is not shown');
    const items = Array.from({ length: 5_000 }, () => '- item').join('\n');
    const list = parseMarkdown(items)[0];
    expect(list && list.t === 'list' ? list.items.length : 0).toBeLessThanOrEqual(400);
  });
});
