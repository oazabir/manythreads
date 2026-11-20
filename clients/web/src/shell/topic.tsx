import { createContext, useContext, useEffect, useLayoutEffect, type ReactNode } from 'react';

/** What a screen says beside its title in the centre header (a channel's purpose, as the plate's "Ship coordination"). */
export const HeaderTopicContext = createContext<(text: string | null) => void>(() => undefined);

/** Shows `text` beside the header title while the calling screen is mounted; nothing for `null` or an empty string. */
export function useHeaderTopic(text: string | null | undefined): void {
  const set = useContext(HeaderTopicContext);
  useEffect(() => {
    set(text && text.trim() !== '' ? text : null);
    return () => set(null);
  }, [set, text]);
}

/** The node a screen puts in place of the header's plain title (the channel name as a button that opens the details menu, P21-06). */
export const HeaderTitleContext = createContext<(node: ReactNode) => void>(() => undefined);
export function useHeaderTitle(node: ReactNode): void {
  const set = useContext(HeaderTitleContext);
  useEffect(() => {
    set(node);
    return () => set(null);
  }, [set, node]);
}

/** The element in the centre header where a screen puts its own buttons (Files: New page, New folder, Upload); null before the header has mounted. */
export const HeaderActionsContext = createContext<HTMLElement | null>(null);
export const useHeaderActionsSlot = (): HTMLElement | null => useContext(HeaderActionsContext);

/** The item a screen shows (a bot's name under Bots), named while it is mounted: the browser tab says it (the band has no trail any more, P34-06). */
export const CrumbTailContext = createContext<(label: string | null) => void>(() => undefined);
export function useCrumbTail(label: string | null | undefined): void {
  const set = useContext(CrumbTailContext);
  useEffect(() => {
    set(label && label.trim() !== '' ? label : null);
    return () => set(null);
  }, [set, label]);
}

/**
 * Where a page's title goes in the shell's band (P34-06): a `PageHeader` inside the shell draws its h1 there, so a screen's header is one row, the title
 * on the left and the tools on the right, like a channel's. Null outside the shell (the settings and account frames) and while a screen draws its own
 * bands (the Threads inbox on a wide screen): the header is then drawn where the screen puts it.
 */
export const HeaderTitleSlotContext = createContext<HTMLElement | null>(null);
export const useHeaderTitleSlot = (): HTMLElement | null => useContext(HeaderTitleSlotContext);

/**
 * How many page headers are mounted. The shell draws a fallback title only while none is, so a screen that has not moved to `PageHeader`
 * still has exactly one h1 and a migrated one never makes two.
 */
export const PageHeaderRegistry = createContext<(delta: 1 | -1) => void>(() => undefined);

/** For a screen that draws its own h1 inside a list pane (the conversation list): tells the shell not to add a title of its own. */
export function useOwnsPageTitle(): void {
  const register = useContext(PageHeaderRegistry);
  // before the browser paints, so the shell's fallback title and the page's own are never both drawn
  useLayoutEffect(() => {
    register(1);
    return () => register(-1);
  }, [register]);
}

/** The same, as an element: render it next to the h1 so ownership starts and ends with the heading (not with a screen's early returns). */
export function OwnsPageTitle(): null {
  useOwnsPageTitle();
  return null;
}
