import { useState } from 'react';
import { SearchIcon } from '../shell/icons';
import { SearchBox } from './SearchBox';

/**
 * The magnifier in a channel's or conversation's header (P21-06): "Search this conversation" opens a search box limited to that conversation, and the
 * results open in the right panel. Escape or leaving the empty box folds it back to the button.
 */
export function ChannelSearch({ channelId }: { channelId: string }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" className="icon-btn chs-btn" aria-label="Search this conversation" title="Search this conversation" data-testid="conversation-search-open" onClick={() => setOpen(true)}>
        <SearchIcon />
      </button>
    );
  }
  return (
    <div className="chs" onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget) && e.currentTarget.querySelector('input')?.value.trim() === '') setOpen(false); }}>
      <SearchBox className="head-search chs-box" placeholder="Search this conversation" label="Search this conversation" channelId={channelId} autoFocus />
    </div>
  );
}
