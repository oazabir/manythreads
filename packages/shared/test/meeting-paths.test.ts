import { describe, expect, it } from 'vitest';
import { isGuardedRepoPath, isMeetingsPath, meetingFolderName, meetingRepoDir } from '../src/index.ts';

// The `meetings/` folder of a team repo: the platform writes it and nobody commits it directly; no proposal changes it either.
describe('the meetings folder of the team repo', () => {
  it('is guarded, and named as its own place', () => {
    for (const p of ['meetings', 'meetings/2026/11/08-1402-sprint-review/notes.md', 'Meetings/2026']) {
      expect(isGuardedRepoPath(p), p).toBe(true);
      expect(isMeetingsPath(p), p).toBe(true);
    }
    for (const p of ['memory/x.md', 'bots/a/BOT.md', 'docs/meetings/x.md', 'meetings-old/x.md']) expect(isMeetingsPath(p), p).toBe(false);
  });
  it('names the folder of one meeting by the UTC date and time', () => {
    const at = new Date('2026-11-08T14:02:59.000Z');
    expect(meetingFolderName(at, 'sprint-review')).toBe('08-1402-sprint-review');
    expect(meetingRepoDir(at, 'sprint-review')).toBe('meetings/2026/11/08-1402-sprint-review');
    expect(meetingRepoDir(new Date('2026-01-02T03:04:00Z'), 'x')).toBe('meetings/2026/01/02-0304-x');
  });
});
