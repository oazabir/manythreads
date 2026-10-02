import { readPanel, sameEntry, writePanel, type PanelEntry, type PanelHistory } from './stack';

export type PanelController = {
  /** Oldest first; the last entry is on screen. */
  stack(): PanelEntry[];
  top(): PanelEntry | null;
  canGoBack(): boolean;
  /** Open an entry on top of what is open. Pushing the entry already on top does nothing. */
  push(entry: PanelEntry): void;
  /** Show the entry underneath. On the last entry it closes the panel. */
  back(): void;
  close(): void;
};

/**
 * `panel.push / back / close` over a history. Each push is a history entry, so the browser's own Back button walks the
 * same stack; `back()` uses it when it can and rewrites the entry when it cannot (a reload or a pasted link).
 */
export function createPanelController(history: PanelHistory): PanelController {
  const state = () => readPanel(history.read());
  const close = (): void => {
    if (state().stack.length === 0) return;
    // a push, not a replace: the browser's Back then reopens the panel exactly as it was
    history.push(writePanel(history.read(), [], false));
  };
  return {
    stack: () => state().stack,
    top: () => state().stack.at(-1) ?? null,
    canGoBack: () => state().stack.length > 1,
    push(entry) {
      const { stack } = state();
      const top = stack.at(-1);
      if (top && sameEntry(top, entry)) return;
      history.push(writePanel(history.read(), [...stack, entry], true));
    },
    back() {
      const { stack, viaPush } = state();
      if (stack.length <= 1) return close();
      if (viaPush) history.back();
      else history.replace(writePanel(history.read(), stack.slice(0, -1), false));
    },
    close,
  };
}
