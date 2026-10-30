import { beforeEach, describe, expect, it } from 'vitest';
import type { GetNotificationLevelsResponse, TeamSummary } from '@manythreads/shared';
import { ApiError, setTransport, type TransportRequest } from '../src/api/client';
import { createChannel } from '../src/api/endpoints';
import { NAME_RULE, buildRequest, canCreateChannel, createErrorText, nameProblem, normalizeChannelName } from '../src/shell/newChannel';
import { badgeText, unreadLook } from '../src/shell/unreadLook';

// The sidebar's "New channel" button and dialog (who is offered it, what is sent, which sentence each refusal gets) and how unread rows
// look for each notification level (P14-15).

const team = (myRole: TeamSummary['myRole'], archivedAt: string | null = null): Pick<TeamSummary, 'myRole' | 'archivedAt'> => ({ myRole, archivedAt });
const uuid = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

describe('who is offered New channel', () => {
  it('a lead and a workspace admin, in a team that is not archived', () => {
    expect(canCreateChannel(team('lead'), false)).toBe(true);
    expect(canCreateChannel(team('member'), true)).toBe(true);
    expect(canCreateChannel(team(null), true)).toBe(true);
  });
  it('not a plain member, not in an archived team, not without a team', () => {
    expect(canCreateChannel(team('member'), false)).toBe(false);
    expect(canCreateChannel(team(null), false)).toBe(false);
    expect(canCreateChannel(team('lead', '2026-10-01T00:00:00.000Z'), true)).toBe(false);
    expect(canCreateChannel(null, true)).toBe(false);
  });
});

describe('the name', () => {
  it('is cleaned the way the server stores it', () => {
    expect(normalizeChannelName('  #Release Notes ')).toBe('release-notes');
    expect(normalizeChannelName('a_b  c')).toBe('a-b-c');
  });
  it('says what is wrong with a name the server would refuse', () => {
    expect(nameProblem('')).toBeNull();
    expect(nameProblem('release notes')).toBeNull();
    expect(nameProblem('-dash')).toBe(NAME_RULE);
    expect(nameProblem('ünïcode')).toBe(NAME_RULE);
    expect(nameProblem('a'.repeat(64))).toBe(NAME_RULE);
    expect(nameProblem('a'.repeat(63))).toBeNull();
  });
});

describe('the request', () => {
  it('carries the clean name, the topic when there is one and private only when chosen', () => {
    expect(buildRequest({ name: '#Ops Room', topic: '  ', isPrivate: false })).toEqual({ ok: true, request: { name: 'ops-room' } });
    expect(buildRequest({ name: 'ops', topic: ' on-call hand-off ', isPrivate: true })).toEqual({ ok: true, request: { name: 'ops', purpose: 'on-call hand-off', private: true } });
  });
  it('refuses an empty name, a bad name and a topic that is too long without asking the server', () => {
    expect(buildRequest({ name: ' ', topic: '', isPrivate: false })).toEqual({ ok: false, problem: 'Give the channel a name.' });
    expect(buildRequest({ name: '!!', topic: '', isPrivate: false })).toEqual({ ok: false, problem: NAME_RULE });
    expect(buildRequest({ name: 'ops', topic: 'x'.repeat(251), isPrivate: false })).toEqual({ ok: false, problem: 'The topic can be at most 250 characters.' });
  });
});

describe('plain sentences for a refusal', () => {
  const err = (status: number, message: string, code: ApiError['code'] = 'conflict'): ApiError => new ApiError({ code, status, message });
  it('maps the closed set of answers', () => {
    expect(createErrorText(err(409, 'A channel named "#ops" already exists in this team'), 'ops')).toBe('A channel named #ops already exists in this team. Pick another name.');
    // a taken name that happens to contain "archived" is still a taken name
    expect(createErrorText(err(409, 'A channel named "#archived-docs" already exists in this team'), 'archived-docs')).toBe('A channel named #archived-docs already exists in this team. Pick another name.');
    expect(createErrorText(err(409, 'This team is archived'), 'ops')).toBe('This team is archived, so it cannot get new channels.');
    expect(createErrorText(err(400, 'name: bad', 'validation_failed'), 'ops')).toBe(NAME_RULE);
    expect(createErrorText(err(403, 'Only a team lead or workspace admin can do that', 'forbidden'), 'ops')).toBe('Only a team lead or a workspace admin can add channels.');
    expect(createErrorText(err(404, 'No team', 'not_found'), 'ops')).toBe('This team no longer exists.');
    expect(createErrorText(err(429, 'slow down', 'rate_limited'), 'ops')).toBe('Too many tries. Wait a moment and try again.');
    expect(createErrorText(err(0, 'offline', 'network'), 'ops')).toBe('Could not reach the server. Check the connection and try again.');
    expect(createErrorText(new Error('boom'), 'ops')).toBe('Could not create the channel. Try again.');
  });
});

describe('createChannel', () => {
  let seen: TransportRequest[];
  beforeEach(() => {
    seen = [];
    setTransport(async (req) => {
      seen.push(req);
      return {
        status: 201,
        body: {
          channel: {
            id: uuid(5), workspaceId: uuid(6), teamId: uuid(7), groupId: null, name: 'ops', kind: 'channel', private: false, purpose: '', dmKey: null, botId: null, position: 1,
            archivedAt: null, createdAt: '2026-10-30T10:00:00.000Z',
          },
        },
      };
    });
  });
  it('posts to the team route and answers the channel', async () => {
    const res = await createChannel('engineering', { name: 'ops', private: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.url).toMatch(/\/api\/teams\/engineering\/channels$/);
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ name: 'ops', private: true });
    expect(res.channel.name).toBe('ops');
  });
});

describe('how an unread row looks', () => {
  const levels = (workspaceDefault: 'all' | 'mentions' | 'nothing', own: Array<[string, 'all' | 'mentions' | 'nothing']> = []): GetNotificationLevelsResponse => ({
    workspaceDefault,
    channels: own.map(([id, level]) => ({ channelId: id as never, channelName: 'x', channelKind: 'channel' as const, level })),
  });
  it('shows nothing when nothing is unread', () => {
    expect(unreadLook(0, levels('all'), uuid(1), 'channel')).toEqual({ bold: false, badge: null });
  });
  it('is bold with a count at the default levels, also before the levels have loaded', () => {
    expect(unreadLook(3, null, uuid(1), 'channel')).toEqual({ bold: true, badge: 'unread' });
    expect(unreadLook(3, levels('mentions'), uuid(1), 'channel')).toEqual({ bold: true, badge: 'unread' });
    expect(unreadLook(3, levels('all'), uuid(1), 'dm')).toEqual({ bold: true, badge: 'unread' });
  });
  it('keeps a grey count and no bold label for a conversation set to nothing', () => {
    expect(unreadLook(3, levels('mentions', [[uuid(1), 'nothing']]), uuid(1), 'channel')).toEqual({ bold: false, badge: 'quiet' });
    expect(unreadLook(3, levels('nothing'), uuid(2), 'channel')).toEqual({ bold: false, badge: 'quiet' });
    // an own choice beats the default
    expect(unreadLook(3, levels('nothing', [[uuid(2), 'all']]), uuid(2), 'channel')).toEqual({ bold: true, badge: 'unread' });
  });
  it('keeps a big count short', () => {
    expect(badgeText(7)).toBe('7');
    expect(badgeText(100)).toBe('99+');
  });
});
