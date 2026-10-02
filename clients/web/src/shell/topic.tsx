import { createContext, useContext, useEffect } from 'react';

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

/** The element in the centre header where a screen puts its own buttons (Files: New page, New folder, Upload); null before the header has mounted. */
export const HeaderActionsContext = createContext<HTMLElement | null>(null);
export const useHeaderActionsSlot = (): HTMLElement | null => useContext(HeaderActionsContext);
