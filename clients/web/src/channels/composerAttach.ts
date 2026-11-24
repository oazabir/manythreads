import type { ComponentType } from 'react';
import { CameraIcon, ScreenIcon } from '../meetings/icons';
import { ClipIcon, ScheduleClockIcon, ToolEmojiIcon, ToolFormatIcon, ToolPollIcon } from '../shell/icons';

/*
 * What the composer's Attach button offers (P36-09, owner 2026-11-24): the box shows only three buttons, Attach, Voice message and Send, and everything
 * else a person can add to a message sits in Attach's menu. The menu is drawn from this list, so a new thing to add is one entry here (its words, its
 * icon, when it is offered and what it does); nothing else in the composer has to change. The order of the list is the order of the menu.
 */

/** What the box around the menu knows: what this conversation allows, and the state of the draft. */
export type AttachEnv = {
  /** The server stores files for this conversation. */
  files: boolean;
  /** The browser can share a screen (a screenshot or a screen recording), and the person is not a guest. */
  capture: boolean;
  /** Polls make sense here (the slash commands' team: a channel, a thread, a direct message; not Brain chat). */
  polls: boolean;
  /** "Send later" is offered in this box. */
  sendLater: boolean;
  /** The box holds text to send (Send later needs some). */
  hasText: boolean;
  /** The box holds files (Send later takes text only). */
  hasFiles: boolean;
  /** A message is being scheduled right now. */
  busy: boolean;
  /** The formatting bar is shown above the box. */
  formatShown: boolean;
};

/** What a menu item can ask the composer to do. */
export type AttachActions = {
  pickFile: () => void;
  capture: (kind: 'image' | 'video') => void;
  poll: () => void;
  emoji: () => void;
  sendLater: () => void;
  toggleFormat: () => void;
};

export type AttachEntry = {
  id: string;
  label: (env: AttachEnv) => string;
  /** One short line under the label. */
  hint: string;
  testId: string;
  Icon: ComponentType;
  /** Offered in this box at all. */
  when: (env: AttachEnv) => boolean;
  /** Offered but not usable now: the sentence that says why (shown as the hint, and the item cannot be chosen). */
  blocked?: (env: AttachEnv) => string | null;
  /** The item opens a dialog or a picker of its own (it then takes the focus). */
  opens?: 'dialog' | 'menu';
  run: (a: AttachActions) => void;
};

export const ATTACH_ENTRIES: readonly AttachEntry[] = [
  {
    id: 'file',
    label: () => 'Attach a file',
    hint: 'From this device. You can also drop or paste one into the box',
    testId: 'attach-file',
    Icon: ClipIcon,
    when: (e) => e.files,
    opens: 'dialog',
    run: (a) => a.pickFile(),
  },
  {
    id: 'screenshot',
    label: () => 'Take a screenshot',
    hint: 'A screen, a window or a tab, or a part of it',
    testId: 'capture-image',
    Icon: ScreenIcon,
    when: (e) => e.files && e.capture,
    opens: 'dialog',
    run: (a) => a.capture('image'),
  },
  {
    id: 'recording',
    label: () => 'Record your screen',
    hint: 'A video of up to 3 minutes, with the tab’s sound',
    testId: 'capture-video',
    Icon: CameraIcon,
    when: (e) => e.files && e.capture,
    opens: 'dialog',
    run: (a) => a.capture('video'),
  },
  {
    id: 'poll',
    label: () => 'Ask a poll',
    hint: 'A question with choices people vote on',
    testId: 'poll-tool',
    Icon: ToolPollIcon,
    when: (e) => e.polls,
    opens: 'dialog',
    run: (a) => a.poll(),
  },
  {
    id: 'emoji',
    label: () => 'Emoji',
    hint: 'Or type : and two letters',
    testId: 'attach-emoji',
    Icon: ToolEmojiIcon,
    when: () => true,
    opens: 'dialog',
    run: (a) => a.emoji(),
  },
  {
    id: 'send-later',
    label: () => 'Send later',
    hint: 'Pick a time for this message',
    testId: 'send-later',
    Icon: ScheduleClockIcon,
    when: (e) => e.sendLater,
    blocked: (e) => (e.busy ? 'Scheduling the message…' : !e.hasText ? 'Write a message first' : e.hasFiles ? 'A scheduled message holds text only' : null),
    opens: 'menu',
    run: (a) => a.sendLater(),
  },
  {
    id: 'format',
    label: (e) => (e.formatShown ? 'Hide formatting' : 'Show formatting'),
    hint: 'Bold, lists, code and links. Their shortcuts work without the bar',
    testId: 'composer-format-toggle',
    Icon: ToolFormatIcon,
    when: () => true,
    run: (a) => a.toggleFormat(),
  },
];

/** One line of the menu as it is drawn now. */
export type AttachItem = { entry: AttachEntry; label: string; hint: string; blocked: string | null };

/** The menu for a box: the entries it offers, in order, with their words for the draft as it is. */
export function attachItems(env: AttachEnv, entries: readonly AttachEntry[] = ATTACH_ENTRIES): AttachItem[] {
  return entries
    .filter((e) => e.when(env))
    .map((entry) => {
      const blocked = entry.blocked?.(env) ?? null;
      return { entry, label: entry.label(env), hint: blocked ?? entry.hint, blocked };
    });
}
