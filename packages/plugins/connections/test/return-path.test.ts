import { describe, expect, it } from 'vitest';
import { safeReturn, withParam } from '../src/person-routes.ts';

describe('the page a sign-in returns to', () => {
  it('keeps a path of this site', () => {
    expect(withParam(safeReturn('/settings/connections?x=1'), 'connected', 'google')).toBe('/settings/connections?x=1&connected=google');
  });

  it('refuses a second leading slash, even one that appears only after the path is normalised', () => {
    for (const raw of ['//evil.com', '/a/..//evil.com', '/.//evil.com']) {
      const location = withParam(safeReturn(raw), 'connected', 'google');
      expect(location.startsWith('//')).toBe(false);
      expect(location.startsWith('/')).toBe(true);
    }
  });
});
