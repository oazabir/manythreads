import { useState } from 'react';
import { SearchIcon } from '../shell/icons';
import { useNarrow } from '../shell/useNarrow';
import { SearchBox } from './SearchBox';

/**
 * The search of a channel's or conversation's header (P33-04). On a screen wide enough it is a bar that takes the header's free space ("Search #dev"; in a conversation
 * "Search this conversation"): pressing Enter searches that one conversation and the results open in the right panel. On a phone there is no room for a bar, so it stays the
 * magnifier of P21-06: it opens a search box, and Escape or leaving the empty box folds it back to the button.
 */
export function ChannelSearch({ channelId, placeholder }: { channelId: string; placeholder: string }) {
  const narrow = useNarrow();
  const [open, setOpen] = useState(false);
  if (!narrow) {
    return <SearchBox className="head-search chv-tool chv-search" placeholder={placeholder} label="Search this conversation" channelId={channelId} />;
  }
  if (!open) {
    return (
      <button type="button" className="icon-btn chs-btn chv-tool chv-search-btn" aria-label="Search this conversation" title="Search this conversation" data-testid="conversation-search-open" onClick={() => setOpen(true)}>
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
