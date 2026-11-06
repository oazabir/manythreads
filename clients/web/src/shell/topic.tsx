import { createContext, useContext, useEffect, type ReactNode } from 'react';

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

/** The last crumb of the shell band's trail (a bot's name under Bots): a screen names the item it shows while it is mounted. */
export const CrumbTailContext = createContext<(label: string | null) => void>(() => undefined);
export function useCrumbTail(label: string | null | undefined): void {
  const set = useContext(CrumbTailContext);
  useEffect(() => {
    set(label && label.trim() !== '' ? label : null);
    return () => set(null);
  }, [set, label]);
}

/**
 * How many page headers are mounted. The shell draws a fallback title only while none is, so a screen that has not moved to `PageHeader`
 * still has exactly one h1 and a migrated one never makes two.
 */
export const PageHeaderRegistry = createContext<(delta: 1 | -1) => void>(() => undefined);
