import { expectLinear } from '@manythreads/test-utils/linear';
import { describe, expect, it } from 'vitest';
import { CHUNK_MAX, CHUNK_TARGET, MAX_CHUNKS_PER_DOCUMENT, chunkText } from '../src/chunk.ts';

// P8-07: how a document's text is cut into passages. What matters: every passage is an exact slice of the text (so a citation can point at the
// place), none is over the database's bound, a passage never straddles two sections, and the cost is linear whatever the text looks like.

describe('chunkText', () => {
  it('keeps short paragraphs together, up to about the target, and cuts on a paragraph break', () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}: ${'word '.repeat(40)}`.trim());
    const text = paragraphs.join('\n\n');
    const { chunks, truncated } = chunkText(text, []);
    expect(truncated).toBe(false);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(text.slice(c.start, c.end)).toBe(c.text);
      expect(c.text.length).toBeLessThanOrEqual(CHUNK_TARGET);
      expect(c.text.startsWith('Paragraph')).toBe(true);
    }
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_c, i) => i));
  });

  it('never makes a passage over the bound, even for one enormous line, and covers all of the text', () => {
    const text = `${'x'.repeat(40_000)} ${'y'.repeat(3_000)}`;
    const { chunks } = chunkText(text, []);
    expect(chunks.length).toBeGreaterThan(20);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(CHUNK_MAX);
      expect(text.slice(c.start, c.end)).toBe(c.text);
    }
    expect(chunks.map((c) => c.text).join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
  });

  it('splits an over-long paragraph at sentence ends where it can', () => {
    const sentence = 'Refunds are paid within fourteen days of the request. ';
    const text = sentence.repeat(60);
    const { chunks } = chunkText(text, []);
    for (const c of chunks.slice(0, -1)) expect(c.text.endsWith('.')).toBe(true);
  });

  it('does not let a passage cross from one section into the next, and labels each with its section', () => {
    const text = '# Refunds\n\nPaid in 14 days.\n\n# Shipping\n\nShips in 2 days.';
    const sections = [
      { label: 'Refunds', start: 0 },
      { label: 'Shipping', start: text.indexOf('# Shipping') },
    ];
    const { chunks } = chunkText(text, sections);
    expect(chunks.map((c) => c.section)).toEqual(['Refunds', 'Shipping']);
    expect(chunks[0]?.text).toContain('Paid in 14 days.');
    expect(chunks[0]?.text).not.toContain('Shipping');
  });

  it('answers no passages for text that is only whitespace', () => {
    expect(chunkText('  \n\n \t \n', []).chunks).toEqual([]);
    expect(chunkText('', []).chunks).toEqual([]);
  });

  it('stops at the most passages one document may make and says so', () => {
    const text = Array.from({ length: MAX_CHUNKS_PER_DOCUMENT + 50 }, (_, i) => `section ${i}`).join('\n\n');
    const sections = Array.from({ length: MAX_CHUNKS_PER_DOCUMENT + 50 }, (_, i) => ({ label: `s${i}`, start: text.indexOf(`section ${i}`) }));
    const out = chunkText(text, sections);
    expect(out.chunks).toHaveLength(MAX_CHUNKS_PER_DOCUMENT);
    expect(out.truncated).toBe(true);
  });

  it.each([
    ['one giant line', (n: number) => 'a '.repeat(n / 2)],
    ['blank lines only', (n: number) => '\n'.repeat(n)],
    ['many tiny paragraphs', (n: number) => 'p\n\n'.repeat(n / 3)],
    ['spaces and tabs', (n: number) => ' \t'.repeat(n / 2) + 'end'],
    ['a long run with no space', (n: number) => 'z'.repeat(n)],
  ])('costs the same per character whatever the shape: %s', (label, build) => {
    expectLinear(build, (text) => chunkText(text, []), { n: 40_000, label });
  });
});
