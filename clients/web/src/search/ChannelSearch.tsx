import { useLayoutEffect, useRef, useState } from 'react';
import { useHeaderItem } from '../shell/headerMenu';
import { headerRoom, useElementWidth } from '../shell/headerRoom';
import { SearchIcon } from '../shell/icons';
import { useNarrow } from '../shell/useNarrow';
import { SearchBox } from './SearchBox';

/**
 * The search of a channel's or conversation's header (P33-04). On a screen wide enough it is a bar that takes the header's free space ("Search #dev"; in a conversation
 * "Search this conversation"): pressing Enter searches that one conversation and the results open in the right panel. On a phone there is no room for a bar, so it stays the
 * magnifier of P21-06: it opens a search box, and Escape or leaving the empty box folds it back to the button. The same magnifier stands in when a right panel leaves the header
 * too little room for a bar; there the box opens under the header instead of pushing the buttons off it. On a phone the magnifier is not drawn in the header (P34-05): the
 * channel details menu's "Search this conversation" opens the same box, and Escape gives the keyboard back to the channel's name.
 */
export function ChannelSearch({ channelId, placeholder }: { channelId: string; placeholder: string }) {
  const phone = useNarrow();
  // the header this search sits in (it is drawn into the header's slot): when its width leaves no room for a bar, the magnifier stands in
  const [head, setHead] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setHead(document.querySelector<HTMLElement>('header.chead')), []);
  const room = headerRoom(useElementWidth(head));
  const narrow = phone || room !== 'bar';
  const [open, setOpen] = useState(false);
  // where the keyboard was when the details menu opened the box (its name button): Escape goes back there, since the magnifier is hidden on a phone
  const returnTo = useRef<HTMLElement | null>(null);
  useHeaderItem(channelId, { key: 'search', label: 'Search this conversation', testId: 'details-search', popup: true }, () => {
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  });
  const fold = (): void => {
    setOpen(false);
    const back = returnTo.current;
    returnTo.current = null;
    if (phone && back?.isConnected) back.focus();
  };
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
    <div className={`chs${phone ? '' : ' chs-float'}`} onKeyDown={(e) => { if (e.key === 'Escape') fold(); }} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget) && e.currentTarget.querySelector('input')?.value.trim() === '') { returnTo.current = null; setOpen(false); } }}>
      <SearchBox className="head-search chs-box" placeholder="Search this conversation" label="Search this conversation" channelId={channelId} autoFocus />
    </div>
  );
}
