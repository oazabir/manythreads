import { useEffect, useRef, useSyncExternalStore } from 'react';

/*
 * The channel header's tools as items of the channel details menu (P34-05). On a phone the header is the channel's name and the bell only (owner decision e,
 * 2026-11-19): search, the planned-room chip, the voice room, Members and Add a link are not drawn there, so each of them hands the details menu an item
 * that does what its button does. The tools stay mounted (only hidden), so the item runs the tool's own code: the same search box, the same "join or start",
 * the same Members panel, the same link dialog. Bot Board and Schedule a room were already menu items (P33-08) and stay as they are.
 */

export type HeaderToolKey = 'search' | 'planned' | 'voice' | 'members' | 'link';

/** The order of the items in the menu: the header's own order, left to right (channels.css `.chv-*` order). */
export const HEADER_TOOL_ORDER: readonly HeaderToolKey[] = ['search', 'planned', 'voice', 'members', 'link'];

export type HeaderMenuItem = {
  key: HeaderToolKey;
  /** What the item says, which is what the button is called ("Search this conversation", "Members (6)"). */
  label: string;
  testId: string;
  /** A state shown in the menu but not a thing to press ("In this call"). */
  disabled?: boolean;
  /** The item opens a dialog or a box (`aria-haspopup`). */
  popup?: boolean;
  /** A toggle that is on (the Members panel is open). */
  pressed?: boolean;
};

export type HeaderMenuEntry = HeaderMenuItem & { run: () => void };

const held = new Map<string, Map<HeaderToolKey, HeaderMenuEntry>>();
const lists = new Map<string, readonly HeaderMenuEntry[]>();
const listeners = new Set<() => void>();
const EMPTY: readonly HeaderMenuEntry[] = [];

/** The items of a channel in the menu's order. */
export const orderItems = (items: Iterable<HeaderMenuEntry>): HeaderMenuEntry[] => [...items].sort((a, b) => HEADER_TOOL_ORDER.indexOf(a.key) - HEADER_TOOL_ORDER.indexOf(b.key));

function changed(channelId: string): void {
  const own = held.get(channelId);
  if (own && own.size > 0) lists.set(channelId, orderItems(own.values()));
  else {
    held.delete(channelId);
    lists.delete(channelId);
  }
  listeners.forEach((l) => l());
}

/** Puts a tool's item in the menu of a channel; the function it returns takes it out again (unless another copy of the tool has put its own since). */
export function putHeaderItem(channelId: string, entry: HeaderMenuEntry): () => void {
  let own = held.get(channelId);
  if (!own) {
    own = new Map();
    held.set(channelId, own);
  }
  own.set(entry.key, entry);
  changed(channelId);
  return () => {
    const now = held.get(channelId);
    if (now?.get(entry.key) !== entry) return;
    now.delete(entry.key);
    changed(channelId);
  };
}

/** The items the tools of this channel have put in its menu. */
export const headerItems = (channelId: string): readonly HeaderMenuEntry[] => lists.get(channelId) ?? EMPTY;

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useHeaderItems(channelId: string): readonly HeaderMenuEntry[] {
  return useSyncExternalStore(subscribe, () => headerItems(channelId), () => EMPTY);
}

/**
 * A header tool's item in the details menu while the tool is on screen; `item` null puts none (a tool that draws nothing). `run` is read when the item is
 * pressed, so it may change on every render without the menu drawing again.
 */
export function useHeaderItem(channelId: string, item: HeaderMenuItem | null, run: () => void): void {
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });
  const key = item?.key ?? null;
  const label = item?.label ?? '';
  const testId = item?.testId ?? '';
  const disabled = item?.disabled ?? false;
  const popup = item?.popup ?? false;
  const pressed = item?.pressed;
  useEffect(() => {
    if (key === null) return;
    return putHeaderItem(channelId, { key, label, testId, disabled, popup, ...(pressed !== undefined ? { pressed } : {}), run: () => runRef.current() });
  }, [channelId, key, label, testId, disabled, popup, pressed]);
}
