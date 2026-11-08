import { describe, expect, it } from 'vitest';
import { AREAS, connectorName, lastDayLine, lastUsedLine, refusedLine, serviceName, servicesLine, stateLook } from '../src/screens/admin/connections/words';

// The plain words of the admin page for connected apps (PLAN Bundle D, P16-11).

describe('names', () => {
  it('uses the catalog name, a chat app name, or the id with a capital', () => {
    expect(connectorName('google')).toBe('Google Workspace');
    expect(connectorName('telegram')).toBe('Telegram');
    expect(connectorName('some_new-thing')).toBe('Some new thing');
    expect(serviceName('google_drive')).toBe('Google drive');
    expect(servicesLine(['drive', 'calendar'])).toBe('Drive, Calendar');
    expect(servicesLine([])).toBe('No services listed');
  });
});

describe('states and days', () => {
  it('a state is a word and a shape', () => {
    expect(stateLook('ok')).toMatchObject({ tone: 'ok', label: 'Working' });
    expect(stateLook('needs_reconnect')).toMatchObject({ tone: 'warn', label: 'Has to sign in again' });
    expect(stateLook('disabled')).toMatchObject({ tone: 'idle', label: 'Switched off' });
  });

  it('shows a day, never a time, and says so when nothing was used', () => {
    expect(lastUsedLine(null)).toBe('Not used yet');
    expect(lastUsedLine('nonsense')).toBe('Not used yet');
    expect(lastUsedLine('2026-10-12')).toMatch(/12/);
    expect(lastDayLine(null)).toBe('Never');
    expect(lastDayLine('2026-10-12T00:00:00.000Z')).not.toMatch(/Used on/);
  });
});

describe('areas and refusals', () => {
  it('every area has its own headings', () => {
    expect(AREAS.map((a) => a.area)).toEqual(['connections', 'webhooks', 'knowledge', 'bridges']);
  });

  it('lists refusal reasons by size and leaves out zero', () => {
    expect(refusedLine({})).toBeNull();
    expect(refusedLine({ bad_signature: 1, unknown_event: 0, too_old: 3 })).toBe('3 too old, 1 bad signature');
  });
});
