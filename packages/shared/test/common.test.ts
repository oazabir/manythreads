import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ErrorCode,
  ErrorEnvelope,
  Message,
  Page,
  TeamRole,
  tokenCssVar,
  tokens,
  WorkspaceRole,
} from '../src/index.ts';
import { messageWire } from './fixtures.ts';

describe('Page', () => {
  it('validates items and cursor', () => {
    const schema = Page(Message);
    expect(schema.parse({ items: [messageWire], nextCursor: 'abc' }).nextCursor).toBe('abc');
    expect(schema.parse({ items: [], nextCursor: null }).items).toEqual([]);
    expect(schema.safeParse({ items: [{}], nextCursor: null }).success).toBe(false);
  });
});

describe('ErrorEnvelope', () => {
  it('accepts a validation failure with a path and details', () => {
    const env = {
      error: {
        code: 'validation_failed',
        message: 'bad body',
        path: ['body', 0],
        details: [{ code: 'too_small', message: 'too short', path: ['body'] }],
      },
    };
    expect(ErrorEnvelope.parse(env)).toEqual(env);
  });

  it('rejects unknown codes', () => {
    expect(ErrorEnvelope.safeParse({ error: { code: 'teapot', message: 'x' } }).success).toBe(false);
  });

  it('lists the documented codes', () => {
    expect(ErrorCode.options).toEqual([
      'validation_failed',
      'not_found',
      'forbidden',
      'rate_limited',
      'conflict',
      'internal',
      'unauthenticated',
      'gone',
    ]);
  });
});

describe('enums', () => {
  // The comparison with the SQL CHECK constraints lives in packages/kernel/test/schema-enums.test.ts: it reads the migrated
  // database, so it needs one.
  it('workspace and team roles are the spec §5 roles', () => {
    expect(WorkspaceRole.options).toEqual(['owner', 'admin', 'member', 'guest']);
    expect(TeamRole.options).toEqual(['lead', 'member']);
  });
  it('ErrorCode is a z.enum', () => {
    expect(ErrorCode).toBeInstanceOf(z.ZodEnum);
  });
});

describe('tokens', () => {
  it('maps every token to a css var', () => {
    expect(tokens.paper).toMatch(/^#[0-9A-F]{6}$/);
    expect(tokens.agentWash).toHaveLength(7);
    expect(tokens.fonts.sans).toBe('Inter Tight');
    expect(tokenCssVar.agentWash).toBe('--agent-wash');
    expect(tokenCssVar.alertWash).toBe('--alert-wash');
    expect(tokenCssVar.fonts.mono).toBe('--mono');
  });
});
