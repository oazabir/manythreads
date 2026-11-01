import { expectLinear } from '@manythreads/test-utils/linear';
import { describe, expect, it } from 'vitest';
import { cleanText, decodeEntities, decodeHtml, hasContent, parseHtmlMeta, parseOembed, resolveHttpUrl, sniffImage } from '../src/parse.ts';

const PAGE = new URL('https://news.example.com/2026/story?id=7');
const parse = (html: string) => parseHtmlMeta(html, PAGE);

describe('parseHtmlMeta: the usual page', () => {
  it('reads Open Graph tags', () => {
    const m = parse(`<!doctype html><html><head>
      <title>Plain title</title>
      <meta property="og:title" content="The Title">
      <meta property="og:description" content="A short summary.">
      <meta property="og:site_name" content="Example News">
      <meta property="og:image" content="/img/cover.png">
      </head><body>hi</body></html>`);
    expect(m).toEqual({
      title: 'The Title',
      description: 'A short summary.',
      siteName: 'Example News',
      image: 'https://news.example.com/img/cover.png',
      oembed: null,
    });
  });

  it('falls back to the title tag, the description meta and Twitter tags', () => {
    const m = parse(`<head><title>  Hello
      world </title><meta name="description" content="Plain description"><meta name="twitter:image" content="https://cdn.example.net/a.jpg"></head>`);
    expect(m.title).toBe('Hello world');
    expect(m.description).toBe('Plain description');
    expect(m.image).toBe('https://cdn.example.net/a.jpg');
  });

  it('prefers Open Graph over Twitter over plain, and the first tag of a kind', () => {
    const m = parse(`<meta name="twitter:title" content="T"><meta property="og:title" content="O1"><meta property="og:title" content="O2">`);
    expect(m.title).toBe('O1');
  });

  it('accepts single quotes, no quotes, odd case and spacing', () => {
    const m = parse(`<META PROPERTY='og:title' CONTENT='Single'><meta property=og:description content=bare><meta   property = "og:site_name"   content = "Spaced" />`);
    expect(m.title).toBe('Single');
    expect(m.description).toBe('bare');
    expect(m.siteName).toBe('Spaced');
  });

  it('finds the oEmbed discovery link and resolves it', () => {
    const m = parse(`<link rel="alternate" type="application/json+oembed" href="/oembed?url=x&amp;format=json" title="x">`);
    expect(m.oembed).toBe('https://news.example.com/oembed?url=x&format=json');
  });

  it('ignores an XML oEmbed link and a link of another kind', () => {
    const m = parse(`<link rel="alternate" type="text/xml+oembed" href="/x"><link rel="stylesheet" type="application/json+oembed" href="/y">`);
    expect(m.oembed).toBeNull();
  });

  it('resolves relative addresses against <base href>, the first one only', () => {
    const m = parse(`<base href="https://cdn.example.org/assets/"><base href="https://evil.example/"><meta property="og:image" content="pic.png">`);
    expect(m.image).toBe('https://cdn.example.org/assets/pic.png');
  });

  it('ignores a <base> that is not http(s)', () => {
    const m = parse(`<base href="javascript:alert(1)"><meta property="og:image" content="/pic.png">`);
    expect(m.image).toBe('https://news.example.com/pic.png');
  });
});

describe('parseHtmlMeta: hostile pages', () => {
  it('does not read meta tags from inside a script, style, textarea or comment', () => {
    const m = parse(`<script>var s = '<meta property="og:title" content="from script">';</script>
      <style>/* <meta property="og:description" content="from style"> */</style>
      <textarea><meta property="og:site_name" content="from textarea"></textarea>
      <!-- <meta property="og:image" content="/from-comment.png"> -->
      <meta property="og:title" content="Real">`);
    expect(m.title).toBe('Real');
    expect(m.description).toBeNull();
    expect(m.siteName).toBeNull();
    expect(m.image).toBeNull();
  });

  it('stops at <body>: tags below it are page content', () => {
    const m = parse(`<head><title>Head</title></head><body><meta property="og:title" content="Injected by a commenter"></body>`);
    expect(m.title).toBe('Head');
  });

  it('does not decode markup out of entities twice', () => {
    expect(decodeEntities('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;');
    expect(decodeEntities('&lt;b&gt;')).toBe('<b>');
    const m = parse(`<meta property="og:title" content="&lt;img src=x onerror=alert(1)&gt;">`);
    // the title is plain text for the client to show as text; the entity is decoded once, the client never sets it as HTML
    expect(m.title).toBe('<img src=x onerror=alert(1)>');
  });

  it.each([
    ['javascript:alert(1)'],
    ['JaVaScRiPt:alert(1)'],
    ['data:image/svg+xml;base64,PHN2Zz4='],
    ['vbscript:x'],
    ['file:///etc/passwd'],
    ['ftp://example.com/a.png'],
    ['//'],
    ['   '],
    [''],
  ])('refuses the image address %j', (value) => {
    const m = parse(`<meta property="og:image" content="${value}">`);
    expect(m.image).toBeNull();
  });

  it('keeps a protocol-relative image address on the page scheme', () => {
    expect(parse(`<meta property="og:image" content="//cdn.example.net/p.png">`).image).toBe('https://cdn.example.net/p.png');
  });

  it('drops an address longer than 2000 characters', () => {
    expect(parse(`<meta property="og:image" content="https://a.example/${'x'.repeat(2100)}">`).image).toBeNull();
  });

  it('strips invisible and direction-changing characters from text', () => {
    const m = parse(`<meta property="og:title" content="pay&#x202E;gpj.exe&#x200B;now&#0;!">`);
    expect(m.title).toBe('paygpj.exenow !'); // a NUL becomes a blank, the direction override and the zero-width space vanish
    expect([...(m.title ?? '')].some((ch) => ['\u202e', '\u200b', '\u0000'].includes(ch))).toBe(false);
  });

  it('cuts long text at the limits without half a surrogate pair', () => {
    const m = parse(`<meta property="og:title" content="${'😀'.repeat(500)}"><meta property="og:description" content="${'d'.repeat(5000)}">`);
    expect(m.title !== null && m.title.length <= 200).toBe(true);
    expect(m.title).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(m.description !== null && m.description.length <= 400).toBe(true);
  });

  it('survives unclosed quotes, unclosed tags and stray brackets', () => {
    expect(() => parse(`<meta property="og:title content="x`)).not.toThrow();
    expect(() => parse(`<<<<>>>><a<b<c<meta<`)).not.toThrow();
    expect(() => parse(`<!-- never closed <meta property="og:title" content="x">`)).not.toThrow();
    expect(parse(`<!-- never closed <meta property="og:title" content="x">`).title).toBeNull();
    expect(parse(`<script> never closed <meta property="og:title" content="x">`).title).toBeNull();
    expect(parse('').title).toBeNull();
    expect(parse('<').title).toBeNull();
  });

  it('reads nothing from a tag whose name only starts like meta', () => {
    expect(parse(`<metadata property="og:title" content="no"><metax property="og:title" content="no">`).title).toBeNull();
  });

  it('caps what a card holds however large the page', () => {
    const big = `<meta property="og:title" content="${'a'.repeat(1_000_000)}">`;
    const m = parse(big);
    expect(m.title !== null && m.title.length <= 200).toBe(true);
  });

  it('treats a title tag with nested markup as text up to the next tag', () => {
    expect(parse(`<title>Hello <b>bold</b></title>`).title).toBe('Hello');
  });
});

describe('parseHtmlMeta: timing on hostile input', () => {
  const cases: Array<[string, (n: number) => string]> = [
    ['unclosed tags', (n) => '<a '.repeat(n)],
    ['unclosed attribute quotes', (n) => '<a b="'.repeat(n)],
    ['single quotes opening and closing', (n) => `<a b='`.repeat(n)],
    ['nested angle brackets', (n) => '<'.repeat(n)],
    ['many meta tags', (n) => '<meta property="p" content="c">'.repeat(n)],
    ['many attributes on one tag', (n) => `<meta ${'a=1 '.repeat(n)}>`],
    ['many comments', (n) => '<!-- x -->'.repeat(n)],
    ['unclosed comments', (n) => '<!--'.repeat(n)],
    ['scripts without end tags', (n) => '<script>'.repeat(n)],
    ['many scripts with end tags', (n) => '<script>a</script>'.repeat(n)],
    ['mismatched raw text', (n) => '<style><script></style></script>'.repeat(n)],
    ['many titles', (n) => '<title>t'.repeat(n)],
    ['entity soup', (n) => `<meta property="og:title" content="${'&amp;&#x41;&bogus;&#;&'.repeat(n)}">`],
    ['whitespace runs', (n) => `<meta property="og:title" content="${' \n\t'.repeat(n)}x">`],
  ];
  it.each(cases)('%s', (label, make) => {
    expectLinear(
      (n) => make(n),
      (html) => parseHtmlMeta(html, PAGE),
      { n: 20_000, label },
    );
  });
});

describe('decodeHtml', () => {
  it('uses the header charset', () => {
    expect(decodeHtml(Buffer.from([0x63, 0x61, 0x66, 0xe9]), 'text/html; charset=iso-8859-1')).toBe('café');
  });
  it('reads a UTF-8 byte-order mark', () => {
    expect(decodeHtml(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi')]), 'text/html')).toBe('hi');
  });
  it('reads a meta charset near the top', () => {
    const bytes = Buffer.concat([Buffer.from('<meta charset="windows-1252"><title>caf'), Buffer.from([0xe9])]);
    expect(decodeHtml(bytes, null)).toContain('café');
  });
  it('falls back to UTF-8 for an unknown charset name and never throws', () => {
    expect(decodeHtml(Buffer.from('plain'), 'text/html; charset=nonsense-9000')).toBe('plain');
    expect(() => decodeHtml(Buffer.from([0xff, 0xfe, 0xfd]), 'text/html; charset=utf-8')).not.toThrow();
  });
});

describe('parseOembed', () => {
  const ENDPOINT = new URL('https://video.example.com/oembed?url=x');

  it('reads title, author, provider and thumbnail', () => {
    const m = parseOembed(
      JSON.stringify({ type: 'video', title: 'A video', author_name: 'Alex', provider_name: 'Vid', thumbnail_url: 'https://i.example.com/t.jpg' }),
      ENDPOINT,
    );
    expect(m).toEqual({ title: 'A video', description: 'Alex', siteName: 'Vid', image: 'https://i.example.com/t.jpg', oembed: null });
  });

  it('never uses the html member (it is markup from the site)', () => {
    const m = parseOembed(JSON.stringify({ type: 'rich', html: '<iframe src="https://evil.example"></iframe><script>alert(1)</script>', title: 'T' }), ENDPOINT);
    expect(JSON.stringify(m)).not.toMatch(/iframe|alert|evil/);
  });

  it('refuses a thumbnail that is not http(s)', () => {
    expect(parseOembed(JSON.stringify({ thumbnail_url: 'javascript:alert(1)' }), ENDPOINT).image).toBeNull();
    expect(parseOembed(JSON.stringify({ thumbnail_url: 'data:text/html,x' }), ENDPOINT).image).toBeNull();
  });

  it.each([['not json'], ['[]'], ['null'], ['"text"'], ['42'], ['{"title": 5, "thumbnail_url": {"a": 1}}'], ['']])('gives nothing for %j', (text) => {
    expect(hasContent(parseOembed(text, ENDPOINT))).toBe(false);
  });

  it('resolves a relative thumbnail against the endpoint', () => {
    expect(parseOembed(JSON.stringify({ thumbnail_url: '/t.png' }), ENDPOINT).image).toBe('https://video.example.com/t.png');
  });
});

describe('text helpers', () => {
  it('cleanText returns null for empty or missing', () => {
    expect(cleanText(null, 10)).toBeNull();
    expect(cleanText('   ', 10)).toBeNull();
    expect(cleanText('​​', 10)).toBeNull();
  });
  it('cleanText cuts with an ellipsis', () => {
    expect(cleanText('abcdefghij', 5)).toBe('abcd…');
    expect(cleanText('abcde', 5)).toBe('abcde');
  });
  it('resolveHttpUrl drops the fragment and refuses other schemes', () => {
    expect(resolveHttpUrl('/a#b', PAGE)).toBe('https://news.example.com/a');
    expect(resolveHttpUrl('mailto:a@b.c', PAGE)).toBeNull();
    expect(resolveHttpUrl(undefined, PAGE)).toBeNull();
  });
});

describe('sniffImage', () => {
  const pad = (head: number[] | string, total = 32): Buffer => {
    const h = typeof head === 'string' ? Buffer.from(head, 'latin1') : Buffer.from(head);
    return Buffer.concat([h, Buffer.alloc(Math.max(0, total - h.length))]);
  };
  it('knows the five kinds by their first bytes', () => {
    expect(sniffImage(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffImage(pad([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(pad('GIF89a'))).toBe('image/gif');
    expect(sniffImage(pad('GIF87a'))).toBe('image/gif');
    expect(sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(8)]))).toBe('image/webp');
    expect(sniffImage(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypavif'), Buffer.alloc(8)]))).toBe('image/avif');
  });
  it.each([
    ['svg', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'],
    ['svg with xml header', '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['html', '<!doctype html><html><script>alert(1)</script></html>'],
    ['html after spaces', '   <html>'],
    ['javascript', 'alert(document.cookie);//////////'],
    ['ico', '\u0000\u0000\u0001\u0000\u0001\u0000 padding padding'],
    ['bmp', 'BM' + 'x'.repeat(30)],
    ['heic', '\u0000\u0000\u0000\u0018ftypheic' + 'x'.repeat(16)],
    ['riff but not webp', 'RIFF\u0000\u0000\u0000\u0000WAVEfmt ' + 'x'.repeat(8)],
    ['png signature in the middle', 'xxxxxxxx\u0089PNG\r\n\u001a\n' + 'x'.repeat(20)],
    ['too short', 'GIF89a'],
    ['empty', ''],
  ])('refuses %s', (_label, text) => {
    expect(sniffImage(Buffer.from(text, 'latin1'))).toBeNull();
  });
});
