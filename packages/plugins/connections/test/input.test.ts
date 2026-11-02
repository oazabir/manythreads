import { describe, expect, it } from 'vitest';
import { inputProblem, TOOLS } from '../src/index.ts';

// The arguments of a source's tool are the model's. They are held to the schema the model was shown, before a kind sees them. No database.

const DRAFT = { to: 'a@b.co', subject: 's', body: 'b' };

describe('inputProblem', () => {
  it('accepts what the schema describes', () => {
    expect(inputProblem('email.read', {})).toBeNull();
    expect(inputProblem('email.read', { query: 'refund', limit: 5 })).toBeNull();
    expect(inputProblem('email.read', { direction: 'out' })).toBeNull();
    expect(inputProblem('email.draft', DRAFT)).toBeNull();
    expect(inputProblem('email.draft', { body: 'b' })).toBeNull();
    expect(inputProblem('email.send', { body: 'b' })).toBeNull();
  });

  it('refuses a field the schema does not name, a wrong type, a missing field and a value past its limit', () => {
    expect(inputProblem('email.read', { query: 'x', sneaky: 1 })).toMatch(/unexpected field “sneaky”/);
    expect(inputProblem('email.read', { limit: '5' })).toMatch(/^limit:/);
    expect(inputProblem('email.read', { limit: 51 })).toMatch(/^limit:/);
    expect(inputProblem('email.read', { query: 'x'.repeat(201) })).toMatch(/^query:/);
    expect(inputProblem('email.read', { direction: 'sideways' })).toMatch(/^direction:/);
    expect(inputProblem('email.send', {})).toMatch(/body/);
    expect(inputProblem('email.draft', { to: 'not an address', body: 'b' })).toMatch(/^to:/);
    expect(inputProblem('email.draft', { to: ['a@b.c'], body: 'b' })).toMatch(/^to:/);
    expect(inputProblem('email.send', { body: 'x'.repeat(40_001) })).toMatch(/^body:/);
    expect(inputProblem('email.read', null)).not.toBeNull();
    expect(inputProblem('email.read', [])).not.toBeNull();
  });

  it('email.send names no recipient: any address field is refused, so the model cannot choose who a mail goes to', () => {
    for (const field of ['to', 'cc', 'bcc', 'recipient', 'from', 'replyTo']) {
      expect(inputProblem('email.send', { body: 'b', [field]: 'attacker@example.com' }), field).toMatch(/unexpected field/);
    }
  });

  it('refuses a null character (U+0000) in any text, naming the field: the database cannot store it', () => {
    const nul = String.fromCharCode(0);
    expect(inputProblem('email.send', { body: `a${nul}b` })).toContain('body');
    expect(inputProblem('email.draft', { to: 'a@b.co', subject: `a${nul}b`, body: 'b' })).toContain('subject');
    expect(inputProblem('email.draft', { to: 'a@b.co', subject: 's', body: `a${nul}b` })).toContain('body');
    expect(inputProblem('email.read', { query: `a${nul}b` })).toContain('query');
    expect(inputProblem('email.send', { body: 'fine' })).toBeNull();
  });

  it('never repeats a value it refused', () => {
    expect(inputProblem('email.send', { body: 'SENTINEL-secret'.repeat(5000) })).not.toContain('SENTINEL');
    expect(inputProblem('email.read', { SENTINEL_FIELD: 'SENTINEL-value' })).not.toContain('SENTINEL-value');
  });

  it('a tool with no schema takes no input', () => {
    expect(inputProblem('email.unknown', {})).not.toBeNull();
  });

  it('the JSON Schema a model is shown is the same definition: strict, with the same required fields', () => {
    const send = TOOLS.find((t) => t.name === 'email.send')!.inputSchema as { type: string; required: string[]; additionalProperties: boolean; properties: Record<string, unknown>; $schema?: string };
    expect(send.type).toBe('object');
    expect(send.additionalProperties).toBe(false);
    expect([...send.required].sort()).toEqual(['body']);
    expect(Object.keys(send.properties).sort()).toEqual(['body']);
    expect(send.$schema).toBeUndefined();
    for (const tool of TOOLS) expect(tool.inputSchema, tool.name).toMatchObject({ type: 'object', additionalProperties: false });
  });
});
