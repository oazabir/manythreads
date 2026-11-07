const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = mac ? '⌘' : 'Ctrl';

/** What the Shortcuts list shows, in the order a person would look for them. */
export function chatShortcuts(): ReadonlyArray<{ keys: string; does: string }> {
  return [
    { keys: `${MOD}+Shift+O`, does: 'Start a new chat' },
    { keys: `${MOD}+K`, does: 'Search your chats (in the message box it adds a link)' },
    { keys: `${MOD}+B / ${MOD}+I`, does: 'Bold or italic in the message box' },
    { keys: 'Up arrow', does: 'Edit your last message (in an empty message box)' },
    { keys: ': and two letters', does: 'Find an emoji' },
    { keys: 'J / K', does: 'Next or earlier chat in the history' },
    { keys: 'Esc', does: 'Stop the answer that is being written' },
    { keys: 'Enter', does: 'Send the message' },
    { keys: 'Shift+Enter', does: 'New line in the message' },
    { keys: '?', does: 'Show this list' },
  ];
}
