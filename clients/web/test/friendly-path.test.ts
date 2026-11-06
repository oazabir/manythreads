import { describe, expect, it } from 'vitest';
import { friendlyName, friendlyPath } from '../src/components/friendlyPath';

describe('friendlyPath', () => {
  it('names the platform folders and files in plain words', () => {
    expect(friendlyName('bots', 'bots')).toBe('Bots');
    expect(friendlyName('routines', 'routines')).toBe('Jobs');
    expect(friendlyName('TEAM.md', 'TEAM.md')).toBe('Team file');
    expect(friendlyName('pages/bots', 'bots')).toBe('bots');
    expect(friendlyPath('routines/weekly.yaml')).toBe('Jobs › weekly.yaml');
    expect(friendlyPath('bots/coder/BOT.md')).toBe('Bots › coder › Bot file');
    expect(friendlyPath('pages/reports')).toBe('Pages › reports');
    expect(friendlyPath('')).toBe('Top folder');
  });
});
