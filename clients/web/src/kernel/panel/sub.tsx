import { createContext, useContext, useEffect } from 'react';

/** The line under a panel's title (a thread's channel); the panel type that is on screen sets it, the header draws it. */
export const PanelSubContext = createContext<(text: string | null) => void>(() => undefined);

export function usePanelSub(text: string | null | undefined): void {
  const set = useContext(PanelSubContext);
  useEffect(() => {
    set(text && text !== '' ? text : null);
    return () => set(null);
  }, [set, text]);
}

/** The panel's title when the entry knows better than its type's label (a file's name, as in the prototype's preview header). */
export const PanelTitleContext = createContext<(text: string | null) => void>(() => undefined);

export function usePanelTitle(text: string | null | undefined): void {
  const set = useContext(PanelTitleContext);
  useEffect(() => {
    set(text && text !== '' ? text : null);
    return () => set(null);
  }, [set, text]);
}

/**
 * The element in the panel's header where the entry on screen puts its own icon buttons, before Expand and Close (a thread's Follow and Open channel,
 * P34-06): one row of tools, as in the channel's header. Null until the header has mounted.
 */
export const PanelToolsContext = createContext<HTMLElement | null>(null);
export const usePanelTools = (): HTMLElement | null => useContext(PanelToolsContext);
