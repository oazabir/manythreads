import { McpToolDescriptor } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { canonicalJson, toolsDigest, type OfferedTool } from '../src/digest.ts';

// The tools digest (PLAN P14-22): one hash of what `tools/list` answers a bot. Same list in any order is the same digest; any change a Hermes would read is a new one.

const tool = (name: string, over: Partial<McpToolDescriptor> = {}, needsApproval = false): OfferedTool => ({
  descriptor: McpToolDescriptor.parse({ name, description: `${name} does a thing.`, inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, ...over }),
  needsApproval,
});

describe('toolsDigest', () => {
  const base = [tool('messages.search'), tool('pages.write'), tool('tasks.read')];

  it('is sixty-four hex characters, and the same for a reordered list', () => {
    expect(toolsDigest(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(toolsDigest([base[2]!, base[0]!, base[1]!])).toBe(toolsDigest(base));
  });

  it('does not depend on the order of an input schema’s keys', () => {
    const a = tool('x.y', { inputSchema: { type: 'object', required: ['q'], properties: { q: { type: 'string' }, n: { type: 'number' } } } });
    const b = tool('x.y', { inputSchema: { properties: { n: { type: 'number' }, q: { type: 'string' } }, required: ['q'], type: 'object' } });
    expect(toolsDigest([a])).toBe(toolsDigest([b]));
  });

  it('changes for a grant added or removed, a needsApproval change, a reworded description, a changed schema and a changed destructive flag', () => {
    const digest = toolsDigest(base);
    expect(toolsDigest(base.slice(0, 2))).not.toBe(digest);
    expect(toolsDigest([...base, tool('memory.write')])).not.toBe(digest);
    expect(toolsDigest([base[0]!, tool('pages.write', {}, true), base[2]!])).not.toBe(digest);
    expect(toolsDigest([base[0]!, tool('pages.write', { description: 'A new sentence.' }), base[2]!])).not.toBe(digest);
    expect(toolsDigest([base[0]!, tool('pages.write', { inputSchema: { type: 'object', properties: { q: { type: 'number' } } } }), base[2]!])).not.toBe(digest);
    expect(toolsDigest([base[0]!, tool('pages.write', { destructive: true }), base[2]!])).not.toBe(digest);
  });

  it('is the digest of nothing for a bot with no tools, and not the digest of one tool', () => {
    expect(toolsDigest([])).toMatch(/^[0-9a-f]{64}$/);
    expect(toolsDigest([])).not.toBe(toolsDigest([base[0]!]));
  });
});

describe('canonicalJson', () => {
  it('sorts keys, keeps arrays in order and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: [2, 1], c: undefined, d: { z: null, y: 'x' } })).toBe('{"a":[2,1],"b":1,"d":{"y":"x","z":null}}');
  });

  it('handles a deep value without the stack giving out at a sensible depth', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 500; i += 1) deep = { k: deep };
    expect(canonicalJson(deep).length).toBeGreaterThan(500);
  });
});
