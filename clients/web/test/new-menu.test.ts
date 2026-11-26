import { describe, expect, it } from 'vitest';
import { canCreateChannel } from '../src/shell/newChannel';
import { NEW_ORDER, NEW_PARAM, newMenuFor, startsTier, type NewId, type NewWho } from '../src/shell/newMenu';

// P38-07: the "New" menu in the sidebar. The order is the product decision (the likeliest first), so it is pinned here; the permission rules mirror the screens' own buttons.

const team = (over: Partial<NonNullable<NewWho['team']>> = {}): NonNullable<NewWho['team']> => ({ slug: 'eng', name: 'Engineering', lead: false, archived: false, ...over });
const member: NewWho = { guest: false, admin: false, team: team() };
const ids = (who: NewWho): NewId[] => newMenuFor(who).map((i) => i.id);
const PERSONAL_ONLY: NewId[] = ['file-personal', 'action', 'knowledge', 'routine', 'knowledge-base'];

describe('the order of the New menu', () => {
  it('puts a chat with a bot first, then a person, a channel, a meeting and the two kinds of file', () => {
    expect(NEW_ORDER.slice(0, 6)).toEqual(['chat', 'person', 'channel', 'meeting', 'file-personal', 'file-team']);
  });

  it('keeps the whole list in one fixed order, set-up things last', () => {
    expect(NEW_ORDER).toEqual([
      'chat', 'person', 'channel', 'meeting', 'file-personal', 'file-team',
      'appointment', 'action', 'card', 'knowledge', 'folder',
      'board', 'job', 'routine', 'bot', 'project', 'knowledge-base',
    ]);
  });

  it('offers a lead of a live team every row, in that order', () => {
    expect(ids({ guest: false, admin: false, team: team({ lead: true }) })).toEqual([...NEW_ORDER]);
  });

  it('draws a line only where the group changes, and never before the first row', () => {
    const items = newMenuFor({ guest: false, admin: true, team: team() });
    const lines = items.map((_, i) => startsTier(items, i));
    expect(lines[0]).toBe(false);
    expect(lines.filter(Boolean)).toHaveLength(2);
    expect(items[lines.indexOf(true)]?.tier).toBe(2);
  });
});

describe('who sees what', () => {
  it('shows a guest nothing', () => {
    expect(newMenuFor({ guest: true, admin: false, team: team() })).toEqual([]);
    expect(newMenuFor({ guest: true, admin: true, team: null })).toEqual([]);
  });

  it('keeps the lead-only rows from an ordinary member', () => {
    const got = ids(member);
    for (const id of ['channel', 'board', 'job', 'project'] as const) expect(got).not.toContain(id);
    for (const id of ['chat', 'person', 'meeting', 'file-team', 'appointment', 'card', 'folder', 'bot'] as const) expect(got).toContain(id);
  });

  it('gives a workspace admin the lead-only rows even when they are not a lead of the team', () => {
    const got = ids({ guest: false, admin: true, team: team() });
    for (const id of ['channel', 'board', 'job', 'project'] as const) expect(got).toContain(id);
  });

  it('offers a new channel exactly when the sidebar already offers one', () => {
    const cases = [
      { admin: false, lead: false, archived: false },
      { admin: false, lead: true, archived: false },
      { admin: true, lead: false, archived: false },
      { admin: true, lead: true, archived: true },
      { admin: false, lead: true, archived: true },
    ];
    for (const c of cases) {
      const offered = ids({ guest: false, admin: c.admin, team: team({ lead: c.lead, archived: c.archived }) }).includes('channel');
      const sidebar = canCreateChannel({ myRole: c.lead ? 'lead' : 'member', archivedAt: c.archived ? '2026-01-01T00:00:00.000Z' : null } as never, c.admin);
      expect(offered).toBe(sidebar);
    }
  });

  it('keeps only the personal rows for a person who is on no team', () => {
    expect(ids({ guest: false, admin: false, team: null })).toEqual(PERSONAL_ONLY);
  });

  it('keeps only the personal rows while the team is archived', () => {
    expect(ids({ guest: false, admin: true, team: team({ archived: true }) })).toEqual(PERSONAL_ONLY);
  });
});

describe('where each row leads', () => {
  const by = (who: NewWho): Record<string, unknown> => Object.fromEntries(newMenuFor(who).map((i) => [i.id, i.action]));
  const all = by({ guest: false, admin: true, team: team({ slug: 'eng' }) });

  it('sends a one-shot request in the address to the screen that makes the thing', () => {
    expect(all['chat']).toEqual({ kind: 'go', to: '/t/eng/chat?new=chat' });
    expect(all['person']).toEqual({ kind: 'go', to: '/t/eng/dms?new=person' });
    expect(all['file-personal']).toEqual({ kind: 'go', to: '/files?new=file' });
    expect(all['file-team']).toEqual({ kind: 'go', to: '/t/eng/files?new=file' });
    expect(all['folder']).toEqual({ kind: 'go', to: '/t/eng/files?new=folder' });
    expect(all['appointment']).toEqual({ kind: 'go', to: '/t/eng/schedule?new=appointment' });
    expect(all['card']).toEqual({ kind: 'go', to: '/t/eng/boards?new=card' });
    expect(all['board']).toEqual({ kind: 'go', to: '/t/eng/boards?new=board' });
    expect(all['job']).toEqual({ kind: 'go', to: '/t/eng/jobs?new=job' });
    expect(all['project']).toEqual({ kind: 'go', to: '/t/eng/projects?new=project' });
    expect(all['knowledge']).toEqual({ kind: 'go', to: '/knowledge?new=upload' });
    expect(all['knowledge-base']).toEqual({ kind: 'go', to: '/knowledge?new=base' });
    expect(all['action']).toEqual({ kind: 'go', to: '/account/action-items?new=action' });
    expect(all['routine']).toEqual({ kind: 'go', to: '/account/routines?new=routine' });
  });

  it('opens a dialog on the spot for a channel and a meeting, and the bot page for a new bot', () => {
    expect(all['channel']).toEqual({ kind: 'dialog', dialog: 'channel' });
    expect(all['meeting']).toEqual({ kind: 'dialog', dialog: 'meeting' });
    expect(all['bot']).toEqual({ kind: 'go', to: '/t/eng/bots/new' });
  });

  it('uses one parameter name for every request, and writes a label and a hint for every row', () => {
    for (const a of Object.values(all) as Array<{ kind: string; to?: string }>) if (a.kind === 'go' && a.to?.includes('?')) expect(a.to).toContain(`?${NEW_PARAM}=`);
    const items = newMenuFor({ guest: false, admin: false, team: team({ name: 'Marketing' }) });
    expect(items.find((i) => i.id === 'file-team')?.hint).toContain('Marketing');
    for (const i of items) {
      expect(i.label.trim()).not.toBe('');
      expect(i.hint.trim()).not.toBe('');
    }
  });

  it('encodes a team address', () => {
    const got = newMenuFor({ guest: false, admin: false, team: team({ slug: 'a b' }) }).find((i) => i.id === 'chat');
    expect(got?.action).toEqual({ kind: 'go', to: '/t/a%20b/chat?new=chat' });
  });
});
