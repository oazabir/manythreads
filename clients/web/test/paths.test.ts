import { describe, expect, it } from 'vitest';
import { safeReturnPath, signInUrl } from '../src/app/paths';
import { mockOptionsFrom, resolveMockQuery } from '../src/api/setup';

describe('return path', () => {
  it('keeps same-origin absolute paths only', () => {
    expect(safeReturnPath('/teams/engineering')).toBe('/teams/engineering');
    expect(safeReturnPath('/settings?x=1')).toBe('/settings?x=1');
    expect(safeReturnPath('//evil.example')).toBeNull();
    expect(safeReturnPath('/\\evil.example')).toBeNull();
    expect(safeReturnPath('https://evil.example')).toBeNull();
    expect(safeReturnPath(null)).toBeNull();
  });

  it('builds the sign-in URL with the encoded return path (criterion 4)', () => {
    expect(signInUrl('/teams/engineering?tab=roster')).toBe('/sign-in?return=%2Fteams%2Fengineering%3Ftab%3Droster');
    expect(signInUrl('/')).toBe('/sign-in');
  });
});

describe('mock mode switch', () => {
  it('?mock=1 enables, ?mock=0 disables, otherwise the tab memory or env flag decides', () => {
    expect(resolveMockQuery('?mock=1&as=nadia', undefined, null)).toBe('?mock=1&as=nadia');
    expect(resolveMockQuery('?mock=0', '1', '?mock=1')).toBeNull();
    expect(resolveMockQuery('', undefined, '?mock=1&anon=1')).toBe('?mock=1&anon=1');
    expect(resolveMockQuery('', '1', null)).toBe('?mock=1');
    expect(resolveMockQuery('', undefined, null)).toBeNull();
  });

  it('reads persona and provider options', () => {
    expect(mockOptionsFrom('?mock=1&as=lena&providers=google,microsoft&teams=none')).toMatchObject({ as: 'lena', providers: ['google', 'microsoft'], noTeams: true, anon: false });
  });
});
