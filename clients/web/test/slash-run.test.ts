import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReminderTarget } from '@manythreads/shared';
import type { ActionPlan } from '../src/channels/slash';
import { actionFailureText, lengthText, runSlashAction, type RunContext, type SlashDeps } from '../src/channels/slashRun';
import { AWAY_KEY, chosenBeat, manualAway, setAwayOwner, setManualAway } from '../src/presence/manualAway';

// P14-04 / P14-06: carrying a planned slash command out through the routes of the plugins that own the thing. The routes are fakes here.

const CHANNEL = '11111111-1111-4111-8111-111111111111';
const PERSON = '33333333-3333-4333-8333-333333333333';
const ctx: RunContext = { channelId: CHANNEL, channelLabel: '#dev', whenText: (iso) => `at ${iso}` };

function fakeDeps(over: Partial<SlashDeps> = {}): SlashDeps & { away: boolean } {
  const state = { away: false };
  const deps = {
    createReminder: vi.fn().mockResolvedValue({}),
    saveStatus: vi.fn().mockResolvedValue({}),
    saveDnd: vi.fn().mockResolvedValue({}),
    isAway: () => state.away,
    setAway: (on: boolean) => {
      state.away = on;
    },
    beat: vi.fn().mockResolvedValue({}),
    addMember: vi.fn().mockResolvedValue({ added: true }),
    leave: vi.fn().mockResolvedValue({ left: true }),
    saveLevel: vi.fn().mockResolvedValue({}),
    saveTopic: vi.fn().mockResolvedValue({}),
    ...over,
  };
  Object.defineProperty(deps, 'away', { get: () => state.away });
  return deps as SlashDeps & { away: boolean };
}

const refusal = (status: number, message = 'x'): Error & { status: number } => Object.assign(new Error(message), { status });

describe('lengthText', () => {
  it('says a pause in words', () => {
    expect(lengthText(1)).toBe('1 minute');
    expect(lengthText(30)).toBe('30 minutes');
    expect(lengthText(60)).toBe('1 hour');
    expect(lengthText(120)).toBe('2 hours');
    expect(lengthText(90)).toBe('1 hour 30 minutes');
    expect(lengthText(24 * 60)).toBe('1 day');
    expect(lengthText(3 * 24 * 60)).toBe('3 days');
  });
});

describe('runSlashAction', () => {
  it('sets a reminder through the reminders route with the planned moment, and says when', async () => {
    const deps = fakeDeps();
    const target: ReminderTarget = { kind: 'me' };
    const res = await runSlashAction({ do: 'remind', target, text: 'call the bank', remindAt: '2026-11-02T10:20:00.000Z', to: 'you' }, ctx, deps);
    expect(deps.createReminder).toHaveBeenCalledWith({ target, text: 'call the bank', remindAt: '2026-11-02T10:20:00.000Z' });
    expect(res).toEqual({ tone: 'ok', text: 'Reminder set for you: at 2026-11-02T10:20:00.000Z.' });
  });

  it('never sends a reminder the shared schema would refuse', async () => {
    const deps = fakeDeps();
    const res = await runSlashAction({ do: 'remind', target: { kind: 'me' }, text: 'a\nb', remindAt: '2026-11-02T10:20:00.000Z', to: 'you' }, ctx, deps);
    expect(deps.createReminder).not.toHaveBeenCalled();
    expect(res.tone).toBe('bad');
  });

  it('sets and clears the status', async () => {
    const deps = fakeDeps();
    expect(await runSlashAction({ do: 'status', emoji: '🌴', text: 'on holiday' }, ctx, deps)).toMatchObject({ tone: 'ok' });
    expect(deps.saveStatus).toHaveBeenCalledWith({ status: { emoji: '🌴', text: 'on holiday', clearsAt: null } });
    expect(await runSlashAction({ do: 'status-clear' }, ctx, deps)).toMatchObject({ tone: 'ok', text: 'Your status is cleared.' });
    expect(deps.saveStatus).toHaveBeenLastCalledWith({ status: null });
  });

  it('pauses notifications for a length of time and ends the pause with /dnd off', async () => {
    const deps = fakeDeps();
    const res = await runSlashAction({ do: 'dnd', minutes: 120 }, ctx, deps);
    expect(deps.saveDnd).toHaveBeenCalledWith({ pauseMinutes: 120 });
    expect(res.text).toContain('2 hours');
    await runSlashAction({ do: 'dnd', minutes: null }, ctx, deps);
    expect(deps.saveDnd).toHaveBeenLastCalledWith({ enabled: false, pauseMinutes: null });
  });

  it('toggles away and tells the server at once, whatever the server answers', async () => {
    const deps = fakeDeps({ beat: vi.fn().mockRejectedValue(new Error('offline')) });
    const first = await runSlashAction({ do: 'away' }, ctx, deps);
    expect(deps.away).toBe(true);
    expect(deps.beat).toHaveBeenLastCalledWith('away');
    expect(first).toMatchObject({ tone: 'ok', text: expect.stringContaining('away') });
    const second = await runSlashAction({ do: 'away' }, ctx, deps);
    expect(deps.away).toBe(false);
    expect(deps.beat).toHaveBeenLastCalledWith('online');
    expect(second).toMatchObject({ tone: 'ok', text: expect.stringContaining('online') });
  });

  it('adds a person to the channel, and tells whether they were already in it', async () => {
    const deps = fakeDeps();
    expect(await runSlashAction({ do: 'invite', personId: PERSON, name: 'Rafi Khan' }, ctx, deps)).toEqual({ tone: 'ok', text: 'Rafi Khan was added to #dev.' });
    expect(deps.addMember).toHaveBeenCalledWith(CHANNEL, PERSON);
    const again = fakeDeps({ addMember: vi.fn().mockResolvedValue({ added: false }) });
    expect(await runSlashAction({ do: 'invite', personId: PERSON, name: 'Rafi Khan' }, ctx, again)).toEqual({ tone: 'ok', text: 'Rafi Khan is already in #dev.' });
  });

  it('leaves the channel and asks the page to move away from it', async () => {
    const deps = fakeDeps();
    expect(await runSlashAction({ do: 'leave' }, ctx, deps)).toEqual({ tone: 'ok', text: 'You left #dev.', left: true });
    const notIn = fakeDeps({ leave: vi.fn().mockResolvedValue({ left: false }) });
    expect(await runSlashAction({ do: 'leave' }, ctx, notIn)).toEqual({ tone: 'ok', text: 'You were not in #dev.' });
  });

  it('mutes with the level "nothing" and unmutes by removing the level', async () => {
    const deps = fakeDeps();
    expect((await runSlashAction({ do: 'mute', on: true }, ctx, deps)).text).toContain('muted');
    expect(deps.saveLevel).toHaveBeenLastCalledWith(CHANNEL, 'nothing');
    await runSlashAction({ do: 'mute', on: false }, ctx, deps);
    expect(deps.saveLevel).toHaveBeenLastCalledWith(CHANNEL, null);
  });

  it('changes and clears the topic', async () => {
    const deps = fakeDeps();
    expect(await runSlashAction({ do: 'topic', text: 'Release planning' }, ctx, deps)).toEqual({ tone: 'ok', text: 'The topic is changed.' });
    expect(deps.saveTopic).toHaveBeenLastCalledWith(CHANNEL, 'Release planning');
    expect(await runSlashAction({ do: 'topic', text: '' }, ctx, deps)).toEqual({ tone: 'ok', text: 'The topic is cleared.' });
    expect(deps.saveTopic).toHaveBeenLastCalledWith(CHANNEL, '');
  });

  it('never throws: a refused call becomes a sentence and keeps the text', async () => {
    const plans: ActionPlan[] = [
      { do: 'remind', target: { kind: 'me' }, text: 'x', remindAt: '2026-11-02T10:20:00.000Z', to: 'you' },
      { do: 'status', emoji: null, text: 'x' },
      { do: 'status-clear' },
      { do: 'dnd', minutes: 5 },
      { do: 'invite', personId: PERSON, name: 'Rafi' },
      { do: 'leave' },
      { do: 'mute', on: true },
      { do: 'topic', text: 'x' },
    ];
    const boom = vi.fn().mockRejectedValue(refusal(500, 'database exploded'));
    const deps = fakeDeps({ createReminder: boom, saveStatus: boom, saveDnd: boom, addMember: boom, leave: boom, saveLevel: boom, saveTopic: boom });
    for (const plan of plans) {
      const res = await runSlashAction(plan, ctx, deps);
      expect(res.tone).toBe('bad');
      expect(res.text).not.toContain('exploded');
      expect(res.text).toContain('Try again');
    }
  });
});

describe('actionFailureText', () => {
  it('uses a plain sentence for a limit, a refusal and a closed rule, and the server words for a clear 4xx', () => {
    expect(actionFailureText('remind', refusal(429))).toContain('Too many requests');
    expect(actionFailureText('remind', refusal(403, 'You do not have permission to do that'))).toBe('You are not allowed to set that reminder.');
    expect(actionFailureText('topic', refusal(403, ''))).toBe('You are not allowed to change the topic of this channel.');
    expect(actionFailureText('remind', refusal(409, 'You already have 100 reminders waiting.'))).toBe('You already have 100 reminders waiting.');
    expect(actionFailureText('status', refusal(500, 'boom'))).toContain('could not be changed');
    expect(actionFailureText('dnd', 'weird')).toContain('Do not disturb');
    expect(actionFailureText('mute', null)).toContain('muted');
  });
});

describe('the hand-set away flag', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setManualAway(false);
    setAwayOwner(null);
  });
  const storage = (data: Map<string, string>): void => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
        removeItem: (k: string) => void data.delete(k),
      },
    });
  };

  it('is off when nobody is signed in, and is never set for nobody', () => {
    setManualAway(true);
    expect(manualAway()).toBe(false);
    expect(chosenBeat('online')).toBe('online');
  });

  it('keeps the choice in memory when storage is blocked', () => {
    setAwayOwner('person-1');
    expect(manualAway()).toBe(false);
    setManualAway(true);
    expect(manualAway()).toBe(true);
    expect(chosenBeat('online')).toBe('away');
    expect(chosenBeat(null)).toBe('away');
    setManualAway(false);
    expect(chosenBeat('online')).toBe('online');
    expect(chosenBeat(null)).toBe(null);
  });

  it('is shared between tabs through localStorage, under the id of the person who chose it', () => {
    const data = new Map<string, string>();
    storage(data);
    setAwayOwner('person-1');
    setManualAway(true);
    expect(data.get(AWAY_KEY)).toBe('person-1');
    // another tab's write is seen
    data.delete(AWAY_KEY);
    expect(manualAway()).toBe(false);
    data.set(AWAY_KEY, 'person-1');
    expect(manualAway()).toBe(true);
    setManualAway(false);
    expect(data.has(AWAY_KEY)).toBe(false);
  });

  it('does not carry over to the next person who signs in on the same browser', () => {
    const data = new Map<string, string>();
    storage(data);
    setAwayOwner('person-1');
    setManualAway(true);
    // signed out: nobody is away, and the stored choice stays the first person's
    setAwayOwner(null);
    expect(manualAway()).toBe(false);
    expect(data.get(AWAY_KEY)).toBe('person-1');
    // somebody else signs in: not away, and the heartbeat sends what the tab's activity says
    setAwayOwner('person-2');
    expect(manualAway()).toBe(false);
    expect(chosenBeat('online')).toBe('online');
    // the first person coming back finds their choice
    setAwayOwner('person-1');
    expect(manualAway()).toBe(true);
  });

  it('forgets the memory copy when the person changes (storage blocked)', () => {
    setAwayOwner('person-1');
    setManualAway(true);
    setAwayOwner('person-2');
    expect(manualAway()).toBe(false);
    setAwayOwner('person-1');
    expect(manualAway()).toBe(false);
  });
});
