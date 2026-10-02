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
