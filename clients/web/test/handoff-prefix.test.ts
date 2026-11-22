import { describe, expect, it } from 'vitest';
import { withoutOwnName } from '../src/channels/displayText';

describe('hand-off prefix in a message row', () => {
  it('removes the matching author name and keeps the mention syntax', () => {
    expect(withoutOwnName('Web smoke tester → @release.bot_2: **all green**', 'Web smoke tester'))
      .toBe('→ @release.bot_2: **all green**');
  });

  it('matches punctuation and whitespace literally', () => {
    expect(withoutOwnName('  QA (Web).  → @committer: done', '  QA (Web). '))
      .toBe('→ @committer: done');
  });

  it.each([
    ['different author', 'Web smoke tester → @committer: done', 'Someone else'],
    ['different case', 'web smoke tester → @committer: done', 'Web smoke tester'],
    ['different punctuation', 'QA (Web)! → @committer: done', 'QA (Web).'],
    ['different whitespace', 'Web smoke tester → @committer: done', ' Web smoke tester '],
    ['missing recipient', 'Web smoke tester → rollout delayed', 'Web smoke tester'],
    ['empty handle', 'Web smoke tester → @: done', 'Web smoke tester'],
    ['missing colon', 'Web smoke tester → @committer rollout delayed', 'Web smoke tester'],
    ['extra space before recipient', 'Web smoke tester →  @committer: done', 'Web smoke tester'],
    ['non-leading prefix', 'I asked Web smoke tester → @committer: done', 'Web smoke tester'],
  ])('preserves the body with %s', (_reason, body, author) => {
    expect(withoutOwnName(body, author)).toBe(body);
  });
});
