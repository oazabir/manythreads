import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown, setTaskChecked } from '../src/channels/markdown';
import { PANEL_DEFAULT, PANEL_MIN, clampPanelWidth, maxPanelWidth, widthFromPointer } from '../src/kernel/panel/panelSize';
import { describeToken } from '../src/screens/projects/commands';

describe('file names and paths are drawn as code', () => {
  it('turns a bare file name or path into a code span, without the sentence punctuation', () => {
    expect(parseInline('Edit TEAM.md, then bots/coder/BOT.md.')).toEqual([
      { t: 'text', v: 'Edit ' },
      { t: 'code', v: 'TEAM.md' },
      { t: 'text', v: ', then ' },
      { t: 'code', v: 'bots/coder/BOT.md' },
      { t: 'text', v: '.' },
    ]);
  });
  it('leaves prose, addresses, mentions and channels alone', () => {
    const nodes = parseInline('and/or e.g. 2026/10/28 see https://example.com/a/b.html @engineer #dev kahf.to');
    expect(nodes.filter((n) => n.t === 'code')).toEqual([]);
    expect(nodes.some((n) => n.t === 'link')).toBe(true);
    expect(nodes.some((n) => n.t === 'mention')).toBe(true);
    expect(nodes.some((n) => n.t === 'channel')).toBe(true);
  });
  it('keeps the backticks the author wrote as one code span', () => {
    expect(parseInline('run `pnpm lint` in packages/shared')).toEqual([
      { t: 'text', v: 'run ' },
      { t: 'code', v: 'pnpm lint' },
      { t: 'text', v: ' in ' },
      { t: 'code', v: 'packages/shared' },
    ]);
  });
});

describe('task lists', () => {
  it('reads boxes into a checklist and counts them', () => {
    const [list] = parseMarkdown('- [ ] write the plan\n- [x] review it\n- a note without a box');
    expect(list).toMatchObject({ t: 'list', ordered: false, checks: [false, true, null] });
  });
  it('an ordinary list has no boxes, and a numbered list never does', () => {
    expect(parseMarkdown('- one\n- two')[0]).not.toHaveProperty('checks');
    expect(parseMarkdown('1. [ ] one')[0]).not.toHaveProperty('checks');
  });
  it('sets one box by its number, outside code blocks, and changes nothing else', () => {
    const src = ['- [ ] a', '```', '- [ ] in code', '```', '- [x] b', '- [ ] c'].join('\n');
    expect(setTaskChecked(src, 1, false)).toBe(['- [ ] a', '```', '- [ ] in code', '```', '- [ ] b', '- [ ] c'].join('\n'));
    expect(setTaskChecked(src, 2, true)).toBe(['- [ ] a', '```', '- [ ] in code', '```', '- [x] b', '- [x] c'].join('\n'));
    expect(setTaskChecked(src, 9, true)).toBe(src);
  });
});

describe('the panel width', () => {
  it('stays between the minimum and what leaves the channel its room', () => {
    expect(clampPanelWidth(100, 1440)).toBe(PANEL_MIN);
    expect(clampPanelWidth(5_000, 1440)).toBe(maxPanelWidth(1440));
    expect(maxPanelWidth(1440)).toBe(1440 - 248 - 320);
    expect(clampPanelWidth(Number.NaN, 1440)).toBe(PANEL_DEFAULT);
    // a small window still gets a usable panel
    expect(maxPanelWidth(700)).toBe(PANEL_MIN);
  });
  it('follows the pointer from the window edge', () => {
    expect(widthFromPointer(1000, 1440)).toBe(440);
    expect(widthFromPointer(1430, 1440)).toBe(PANEL_MIN);
    expect(widthFromPointer(0, 1440)).toBe(maxPanelWidth(1440));
  });
});

describe('what the Projects page says about a token', () => {
  const NOW = Date.parse('2026-10-28T10:00:00Z');
  it('says who it is connected as and when it expires, and warns two weeks ahead', () => {
    expect(describeToken({ pushUsername: 'octocat', pushCredentialExpiresAt: '2027-01-15T00:00:00.000Z', pushCredentialStatus: 'ok' }, NOW)).toMatchObject({ tone: 'ok' });
    expect(describeToken({ pushUsername: 'octocat', pushCredentialExpiresAt: '2026-11-05T00:00:00.000Z', pushCredentialStatus: 'ok' }, NOW)).toMatchObject({ tone: 'warn' });
    expect(describeToken({ pushUsername: 'octocat', pushCredentialExpiresAt: '2026-10-01T00:00:00.000Z', pushCredentialStatus: 'ok' }, NOW)).toMatchObject({ tone: 'bad' });
    expect(describeToken({ pushUsername: 'octocat', pushCredentialExpiresAt: null, pushCredentialStatus: 'ok' }, NOW).line).toContain('Connected as octocat');
  });
  it('says the token needs replacing once GitHub refused it', () => {
    expect(describeToken({ pushUsername: 'octocat', pushCredentialExpiresAt: null, pushCredentialStatus: 'needs_replacing' }, NOW)).toMatchObject({ tone: 'bad' });
  });
});

describe('images in pages come from this site only', () => {
  it('accepts a relative address or a path of this origin and nothing else', async () => {
    const { isOwnImage } = await import('../src/viewers/markdown/codec');
    for (const ok of ['/api/files/abc/content', 'img/a.png', './a.png', '../a.png']) expect(isOwnImage(ok), ok).toBe(true);
    for (const bad of ['https://evil.example/p.gif', 'http://x/p.gif', '//evil.example/p.gif', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'JaVa\tScript:x', '\\\\evil\\a.png', 'blob:https://x/1', '', null, 5]) {
      expect(isOwnImage(bad), String(bad)).toBe(false);
    }
  });
});
