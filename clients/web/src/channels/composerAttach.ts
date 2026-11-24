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
  /** The Send later times are open, and the id of their menu (the Send later item points at it). */
  laterOpen?: boolean;
  laterMenuId?: string;
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
  /** A few words for the Attach button's tooltip ("a file", "emoji"). */
  short: string;
  /** It adds something to the message (a file, a recording, a poll): the button is called Attach only when one of these is offered. */
  attaches?: true;
  /** A menu item that opens a menu of its own: whether that menu is open now. */
  expanded?: (env: AttachEnv) => boolean;
  run: (a: AttachActions) => void;
};

export const ATTACH_ENTRIES: readonly AttachEntry[] = [
  {
    id: 'file',
    label: () => 'Attach a file',
    hint: 'From this device. You can also drop or paste one into the box',
    testId: 'attach-file',
    short: 'a file',
    attaches: true,
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
    short: 'a screenshot',
    attaches: true,
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
    short: 'a screen recording',
    attaches: true,
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
    short: 'a poll',
    attaches: true,
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
    short: 'emoji',
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
    short: 'Send later',
    Icon: ScheduleClockIcon,
    when: (e) => e.sendLater,
    blocked: (e) => (e.busy ? 'Scheduling the message…' : !e.hasText ? 'Write a message first' : e.hasFiles ? 'A scheduled message holds text only' : null),
    opens: 'menu',
    expanded: (e) => e.laterOpen === true,
    run: (a) => a.sendLater(),
  },
  {
    id: 'format',
    label: (e) => (e.formatShown ? 'Hide formatting' : 'Show formatting'),
    hint: 'Bold, lists, code and links. Their shortcuts work without the bar',
    testId: 'composer-format-toggle',
    short: 'formatting',
    Icon: ToolFormatIcon,
    when: () => true,
    run: (a) => a.toggleFormat(),
  },
];

/** One line of the menu as it is drawn now. `expanded` and `controls` are set on an item whose own menu is open. */
export type AttachItem = { entry: AttachEntry; label: string; hint: string; blocked: string | null; expanded?: boolean; controls?: string };

/** The menu for a box: the entries it offers, in order, with their words for the draft as it is. */
export function attachItems(env: AttachEnv, entries: readonly AttachEntry[] = ATTACH_ENTRIES): AttachItem[] {
  return entries
    .filter((e) => e.when(env))
    .map((entry) => {
      const blocked = entry.blocked?.(env) ?? null;
      const item: AttachItem = { entry, label: entry.label(env), hint: blocked ?? entry.hint, blocked };
      if (entry.expanded) {
        item.expanded = entry.expanded(env);
        if (item.expanded && env.laterMenuId) item.controls = env.laterMenuId;
      }
      return item;
    });
}

/** "a, b and c" */
const listed = (words: readonly string[]): string => (words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);

/**
 * What the button that opens the menu is called, from what the menu offers here: "Attach" (a paperclip) when something can be attached, with the
 * tooltip naming those things; otherwise "More" (a plus), naming what there is. It never promises a file where the server stores none.
 */
export function attachButtonWords(items: readonly AttachItem[]): { label: 'Attach' | 'More'; title: string } {
  const attach = items.filter((i) => i.entry.attaches).map((i) => i.entry.short);
  const rest = items.filter((i) => !i.entry.attaches).map((i) => i.entry.short);
  if (attach.length > 0) return { label: 'Attach', title: `Attach ${listed(attach)}${rest.length > 0 ? ', and more' : ''}` };
  return { label: 'More', title: rest.length > 0 ? `More: ${listed(rest)}` : 'More' };
}
