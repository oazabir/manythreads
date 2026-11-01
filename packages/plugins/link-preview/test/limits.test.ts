import { describe, expect, it } from 'vitest';
import {
  AUTHOR_PER_HOUR,
  AUTHOR_PER_MINUTE,
  WORKSPACE_PER_HOUR,
  createHostBreaker,
  createLinkBudget,
  linkPreviewEnabled,
} from '../src/limits.ts';

describe('linkPreviewEnabled', () => {
  it.each([
    [{}, true],
    [{ NODE_ENV: 'production' }, true],
    [{ NODE_ENV: 'development' }, true],
    [{ NODE_ENV: 'test' }, false],
    [{ NODE_ENV: 'test', MANYTHREADS_LINK_PREVIEW: 'on' }, true],
    [{ NODE_ENV: 'test', MANYTHREADS_LINK_PREVIEW: '1' }, true],
    [{ NODE_ENV: 'test', MANYTHREADS_LINK_PREVIEW: ' TRUE ' }, true],
    [{ NODE_ENV: 'test', MANYTHREADS_LINK_PREVIEW: 'yes' }, true],
    [{ NODE_ENV: 'production', MANYTHREADS_LINK_PREVIEW: 'off' }, false],
    [{ MANYTHREADS_LINK_PREVIEW: 'OFF' }, false],
    [{ MANYTHREADS_LINK_PREVIEW: '0' }, false],
    [{ MANYTHREADS_LINK_PREVIEW: 'false' }, false],
    [{ MANYTHREADS_LINK_PREVIEW: 'no' }, false],
    // a word it does not know is no decision: the default of the environment applies
    [{ MANYTHREADS_LINK_PREVIEW: 'maybe' }, true],
    [{ NODE_ENV: 'test', MANYTHREADS_LINK_PREVIEW: 'maybe' }, false],
    [{ MANYTHREADS_LINK_PREVIEW: '' }, true],
  ])('%j -> %s', (env, expected) => {
    expect(linkPreviewEnabled(env)).toBe(expected);
  });

  it('reads the environment of the moment, so a test can switch it', () => {
    const before = process.env['MANYTHREADS_LINK_PREVIEW'];
    try {
      process.env['MANYTHREADS_LINK_PREVIEW'] = 'on';
      expect(linkPreviewEnabled()).toBe(true);
      process.env['MANYTHREADS_LINK_PREVIEW'] = 'off';
      expect(linkPreviewEnabled()).toBe(false);
    } finally {
      if (before === undefined) delete process.env['MANYTHREADS_LINK_PREVIEW'];
      else process.env['MANYTHREADS_LINK_PREVIEW'] = before;
    }
  });

  it('is off by default in this test run (vitest sets NODE_ENV=test)', () => {
    const before = process.env['MANYTHREADS_LINK_PREVIEW'];
    try {
      delete process.env['MANYTHREADS_LINK_PREVIEW'];
      expect(process.env['NODE_ENV']).toBe('test');
      expect(linkPreviewEnabled()).toBe(false);
    } finally {
      if (before !== undefined) process.env['MANYTHREADS_LINK_PREVIEW'] = before;
    }
  });
});

describe('createLinkBudget', () => {
  it('lets an author start AUTHOR_PER_MINUTE reads a minute, then says which limit it is', () => {
    let t = 0;
    const budget = createLinkBudget(() => t);
    for (let i = 0; i < AUTHOR_PER_MINUTE; i += 1) expect(budget.take('a', 'w', 1)).toEqual({ ok: true });
    expect(budget.take('a', 'w', 1)).toEqual({ ok: false, scope: 'author' });
    expect(budget.take('b', 'w', 1)).toEqual({ ok: true }); // another author is not held back
    t += 60_001;
    expect(budget.take('a', 'w', 1)).toEqual({ ok: true });
  });

  it('counts a message of several links as several reads, and refuses it whole', () => {
    const budget = createLinkBudget(() => 0);
    expect(budget.take('a', 'w', AUTHOR_PER_MINUTE - 1)).toEqual({ ok: true });
    expect(budget.take('a', 'w', 2)).toEqual({ ok: false, scope: 'author' });
    // nothing of the refused ask was counted
    expect(budget.take('a', 'w', 1)).toEqual({ ok: true });
  });

  it('holds an author to AUTHOR_PER_HOUR across minutes', () => {
    let t = 0;
    const budget = createLinkBudget(() => t);
    let taken = 0;
    for (let minute = 0; minute < 20; minute += 1) {
      for (let i = 0; i < AUTHOR_PER_MINUTE; i += 1) {
        if (budget.take('a', 'w', 1).ok) taken += 1;
      }
      t += 61_000;
    }
    expect(taken).toBe(AUTHOR_PER_HOUR);
    t += 3_600_000;
    expect(budget.take('a', 'w', 1)).toEqual({ ok: true });
  });

  it('holds a whole workspace to WORKSPACE_PER_HOUR, whoever the authors are', () => {
    let t = 0;
    const budget = createLinkBudget(() => t);
    let taken = 0;
    for (let author = 0; author < 100; author += 1) {
      for (let i = 0; i < AUTHOR_PER_MINUTE; i += 1) {
        if (budget.take(`author-${author}`, 'w', 1).ok) taken += 1;
      }
    }
    expect(taken).toBe(WORKSPACE_PER_HOUR);
    expect(budget.take('late-author', 'w', 1)).toEqual({ ok: false, scope: 'workspace' });
    expect(budget.take('late-author', 'other-workspace', 1)).toEqual({ ok: true });
    t += 3_600_001;
    expect(budget.take('late-author', 'w', 1)).toEqual({ ok: true });
  });

  it('forgets everything on reset', () => {
    const budget = createLinkBudget(() => 0);
    for (let i = 0; i < AUTHOR_PER_MINUTE; i += 1) budget.take('a', 'w', 1);
    budget.reset();
    expect(budget.take('a', 'w', 1)).toEqual({ ok: true });
  });
});

describe('createHostBreaker', () => {
  it('opens after threshold failures in a row and closes again after openMs', () => {
    let t = 1000;
    const breaker = createHostBreaker({ threshold: 3, openMs: 60_000, now: () => t });
    expect(breaker.allow('slow.example')).toBe(true);
    breaker.failure('slow.example');
    breaker.failure('slow.example');
    expect(breaker.allow('slow.example')).toBe(true);
    breaker.failure('slow.example');
    expect(breaker.allow('slow.example')).toBe(false);
    expect(breaker.allow('other.example')).toBe(true); // per host
    t += 59_999;
    expect(breaker.allow('slow.example')).toBe(false);
    t += 2;
    expect(breaker.allow('slow.example')).toBe(true);
  });

  it('opens again at the first failure after the cool-down, and a success clears the host', () => {
    let t = 0;
    const breaker = createHostBreaker({ threshold: 2, openMs: 1000, now: () => t });
    breaker.failure('h');
    breaker.failure('h');
    expect(breaker.allow('h')).toBe(false);
    t += 1001;
    expect(breaker.allow('h')).toBe(true); // one read is let through
    breaker.failure('h');
    expect(breaker.allow('h')).toBe(false); // and one failure is enough
    t += 1001;
    breaker.success('h');
    breaker.failure('h');
    expect(breaker.allow('h')).toBe(true); // the count started again
  });

  it('a success between failures keeps the count from adding up', () => {
    const breaker = createHostBreaker({ threshold: 3, now: () => 0 });
    for (let i = 0; i < 10; i += 1) {
      breaker.failure('h');
      breaker.failure('h');
      breaker.success('h');
    }
    expect(breaker.allow('h')).toBe(true);
  });

  it('remembers at most max hosts', () => {
    const breaker = createHostBreaker({ threshold: 1, max: 3, now: () => 0 });
    for (const h of ['a', 'b', 'c', 'd']) breaker.failure(h);
    expect(breaker.allow('a')).toBe(true); // the oldest was forgotten
    expect(breaker.allow('d')).toBe(false);
  });
});
