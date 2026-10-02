import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '../src/channels/Markdown';
import { parseInline, parseMarkdown, safeHref } from '../src/channels/markdown';

const html = (source: string): string => renderToStaticMarkup(createElement(Markdown, { source }));

describe('safe markdown', () => {
  it('never turns text into HTML: tags, handlers and entities stay characters', () => {
    const out = html('<script>alert(1)</script> <img src=x onerror=alert(1)> <b>x</b> &amp;');
    expect(out).not.toMatch(/<script|<img|<b>/);
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('keeps only http, https, mailto and same-site link targets', () => {
    expect(safeHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(safeHref('mailto:nadia@example.com')).toBe('mailto:nadia@example.com');
    expect(safeHref('/t/engineering/c/dev')).toBe('/t/engineering/c/dev');
    for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'data:text/html,x', 'vbscript:x', '//evil.example', '/\\evil', 'https://', 'file:///etc/passwd', 'java\nscript:alert(1)', '']) {
      expect(safeHref(bad), bad).toBeNull();
    }
    const out = html('[click](javascript:alert(1)) and [ok](https://example.com)');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('click');
    expect(out).toContain('href="https://example.com"');
  });

  it('opens external links safely', () => {
    const out = html('[a](https://example.com) https://example.org/x.');
    expect(out.match(/rel="noopener noreferrer nofollow"/g)).toHaveLength(2);
    expect(out.match(/target="_blank"/g)).toHaveLength(2);
    expect(out).toContain('href="https://example.org/x"'); // the trailing full stop is not part of the address
  });

  it('draws emphasis, code spans, fences, lists and quotes', () => {
    expect(html('**bold** *it* ~~gone~~ `x < y`')).toBe('<div class="md"><p><strong>bold</strong> <em>it</em> <del>gone</del> <code>x &lt; y</code></p></div>');
    const fence = html('```ts\nconst a = "<b>";\n```');
    expect(fence).toContain('<pre class="md-code" data-lang="ts"');
    expect(fence).toContain('const a = &quot;&lt;b&gt;&quot;;');
    expect(html('- one\n- two')).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(html('1. a\n2. b')).toContain('<ol><li>a</li><li>b</li></ol>');
    expect(html('> quoted')).toContain('<blockquote><p>quoted</p></blockquote>');
  });

  it('a single newline is a line break; mentions and channels are marked, inside code they are not', () => {
    expect(html('one\ntwo')).toContain('one<br/>two');
    const out = html('hi @nadia see #dev, `@nobody` mail a@b.example');
    expect(out).toContain('<span class="m" data-mention="nadia">@nadia</span>');
    expect(out).toContain('<span class="chref">#dev</span>');
    expect(out).toContain('<code>@nobody</code>');
    expect(out).not.toContain('data-mention="b.example"');
  });

  it('snake_case words are not italic', () => {
    expect(html('use snake_case_names here')).toContain('snake_case_names');
    expect(html('use snake_case_names here')).not.toContain('<em>');
  });

  it('reads hostile input in linear time (MISTAKES P3-05)', () => {
    const inputs = ['**a '.repeat(10_000), '['.repeat(40_000), '`'.repeat(40_000), '*'.repeat(40_000), '_a'.repeat(20_000), '[a](' .repeat(10_000), '@a'.repeat(20_000), '> '.repeat(5_000) + 'x', '- '.repeat(20_000)];
    for (const text of inputs) {
      const t0 = performance.now();
      parseMarkdown(text);
      const ms = performance.now() - t0;
      expect(ms, `${text.slice(0, 8)}... ${text.length} chars`).toBeLessThan(500);
    }
  });

  it('parseInline on a long paragraph is plain text (the cap)', () => {
    const long = `**x** ${'y'.repeat(5_000)}`;
    expect(parseInline(long)).toEqual([{ t: 'text', v: long }]);
  });
});
