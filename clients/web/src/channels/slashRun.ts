import { CreateReminderRequest, type UpdateDndRequest, type UpdateMyPresenceRequest } from '@manythreads/shared';
import type { ActionPlan } from './slash';

/*
 * Carries out a slash command that changes something (PLAN P14-04, P14-06): `/remind`, `/status`, `/dnd`, `/away`, `/invite`, `/leave`, `/mute`,
 * `/topic`. Each one calls the route of the plugin that owns the thing -- the same door the settings screens use -- so a check that door makes
 * is never skipped here. The routes are handed in (`SlashDeps`), so this file is tested without a browser or a server, and it answers with one
 * plain sentence for the screen: what was done, or why not.
 */

export interface SlashDeps {
  createReminder(body: CreateReminderRequest): Promise<unknown>;
  saveStatus(body: UpdateMyPresenceRequest): Promise<unknown>;
  saveDnd(body: UpdateDndRequest): Promise<unknown>;
  /** The person chose to be shown as away (see presence/manualAway.ts). */
  isAway(): boolean;
  setAway(on: boolean): void;
  /** Tells the server at once, instead of at the next heartbeat. A failure is ignored: the heartbeat repeats it. */
  beat(state: 'online' | 'away'): Promise<unknown>;
  addMember(channelId: string, personId: string): Promise<{ added: boolean }>;
  leave(channelId: string): Promise<{ left: boolean }>;
  saveLevel(channelId: string, level: 'nothing' | null): Promise<unknown>;
  saveTopic(channelId: string, purpose: string): Promise<unknown>;
}

/** Where the command was typed, and how to say a moment in words. */
export interface RunContext {
  channelId: string;
  /** "#dev", for the sentences. */
  channelLabel: string;
  whenText(iso: string): string;
}

export type RunResult = { tone: 'ok' | 'bad'; text: string; /** The person left the conversation: the page moves away from it. */ left?: boolean };

const ok = (text: string, extra: { left?: boolean } = {}): RunResult => ({ tone: 'ok', text, ...extra });

/** "30 minutes", "2 hours", "1 day" -- the length of a pause in words. */
export function lengthText(minutes: number): string {
  const unit = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;
  if (minutes < 60) return unit(minutes, 'minute');
  if (minutes % (24 * 60) === 0) return unit(minutes / (24 * 60), 'day');
  if (minutes % 60 === 0) return unit(minutes / 60, 'hour');
  return `${unit(Math.floor(minutes / 60), 'hour')} ${unit(minutes % 60, 'minute')}`;
}

const GENERIC: Record<ActionPlan['do'], string> = {
  remind: 'The reminder could not be set just now. Try again in a moment.',
  status: 'Your status could not be changed just now. Try again in a moment.',
  'status-clear': 'Your status could not be cleared just now. Try again in a moment.',
  dnd: 'Do not disturb could not be changed just now. Try again in a moment.',
  away: 'Your presence could not be changed just now. Try again in a moment.',
  invite: 'The person could not be added just now. Try again in a moment.',
  leave: 'You could not leave just now. Try again in a moment.',
  mute: 'The conversation could not be muted just now. Try again in a moment.',
  topic: 'The topic could not be changed just now. Try again in a moment.',
};

const FORBIDDEN: Partial<Record<ActionPlan['do'], string>> = {
  remind: 'You are not allowed to set that reminder.',
  invite: 'You are not allowed to add people to this channel, or that person is not on its team.',
  topic: 'You are not allowed to change the topic of this channel.',
  leave: 'You cannot leave this channel.',
};

/** The sentence for a refused call: the server's own words when it spoke for a closed rule (4xx), a plain one for a limit, a general one otherwise. */
export function actionFailureText(kind: ActionPlan['do'], err: unknown): string {
  const status = (err as { status?: unknown } | null)?.status;
  const message = (err as { message?: unknown } | null)?.message;
  if (status === 429) return 'Too many requests in a short time. Wait a moment and try again.';
  if (status === 403) return typeof message === 'string' && message.length > 0 && message !== 'You do not have permission to do that' ? message : (FORBIDDEN[kind] ?? GENERIC[kind]);
  if (typeof status === 'number' && status >= 400 && status < 500 && typeof message === 'string' && message.length > 0) return message;
  return GENERIC[kind];
}

/** Carries the plan out and says what happened. Never throws. */
export async function runSlashAction(plan: ActionPlan, ctx: RunContext, deps: SlashDeps): Promise<RunResult> {
  try {
    switch (plan.do) {
      case 'remind': {
        const body = CreateReminderRequest.parse({ target: plan.target, text: plan.text, remindAt: plan.remindAt });
        await deps.createReminder(body);
        return ok(`Reminder set for ${plan.to}: ${ctx.whenText(plan.remindAt)}.`);
      }
      case 'status':
        await deps.saveStatus({ status: { emoji: plan.emoji, text: plan.text, clearsAt: null } });
        return ok('Your status is set. /status clear removes it.');
      case 'status-clear':
        await deps.saveStatus({ status: null });
        return ok('Your status is cleared.');
      case 'dnd':
        if (plan.minutes === null) {
          await deps.saveDnd({ enabled: false, pauseMinutes: null });
          return ok('Do not disturb is off for now. A weekly schedule set in your settings can still turn it on.');
        }
        await deps.saveDnd({ pauseMinutes: plan.minutes });
        return ok(`Notifications are paused for ${lengthText(plan.minutes)}. /dnd off gets them back.`);
      case 'away': {
        const on = !deps.isAway();
        deps.setAway(on);
        await deps.beat(on ? 'away' : 'online').catch(() => undefined);
        return ok(on ? 'You are shown as away until you type /away again.' : 'You are shown as online again.');
      }
      case 'invite': {
        const res = await deps.addMember(ctx.channelId, plan.personId);
        return ok(res.added ? `${plan.name} was added to ${ctx.channelLabel}.` : `${plan.name} is already in ${ctx.channelLabel}.`);
      }
      case 'leave': {
        const res = await deps.leave(ctx.channelId);
        return res.left ? ok(`You left ${ctx.channelLabel}.`, { left: true }) : ok(`You were not in ${ctx.channelLabel}.`);
      }
      case 'mute':
        await deps.saveLevel(ctx.channelId, plan.on ? 'nothing' : null);
        return ok(plan.on ? `${ctx.channelLabel} is muted for you. /mute off lets it notify you again.` : `${ctx.channelLabel} follows your notification settings again.`);
      case 'topic':
        await deps.saveTopic(ctx.channelId, plan.text);
        return ok(plan.text === '' ? 'The topic is cleared.' : 'The topic is changed.');
    }
  } catch (err) {
    return { tone: 'bad', text: actionFailureText(plan.do, err) };
  }
}
