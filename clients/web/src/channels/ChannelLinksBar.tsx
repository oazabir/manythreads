import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import type { BookmarkKind, ChannelBookmark } from '@manythreads/shared';
import { isApiError } from '../api/client';
import { addChannelLink, fetchChannelLinks, fetchChannelFiles, fileContentUrl, removeChannelLink } from '../api/endpoints';
import { useQuery } from '../app/useQuery';
import { Dialog } from '../components/Dialog';
import { useHeaderItem } from '../shell/headerMenu';
import { CloseIcon, ToolLinkIcon } from '../shell/icons';

/** Where a channel link leads: a web address and a file open in a new tab, a page opens in the team's Files screen. */
export function channelLinkHref(b: Pick<ChannelBookmark, 'kind' | 'target'>, teamSlug: string | null): { href: string; external: boolean } | null {
  if (b.kind === 'link') return /^https?:\/\//i.test(b.target) ? { href: b.target, external: true } : null;
  if (b.kind === 'file') return { href: fileContentUrl(b.target), external: true };
  return teamSlug ? { href: `/t/${encodeURIComponent(teamSlug)}/files?open=${encodeURIComponent(b.target)}`, external: false } : null;
}

const KIND_LABEL: Record<BookmarkKind, string> = { link: 'Link', file: 'File', page: 'Page' };

/**
 * The channel's links bar (PLAN P14-12; called "Links" since P36-08, when Bookmarks became a person's own): web addresses, files and pages a channel keeps
 * under its header. Everyone who can read the channel sees it; everyone who can post adds (a button in the header, `slot`) and removes. A channel with
 * none shows no bar at all, so the channel looks as it did. The API and its types still call them bookmarks (`ChannelBookmark`).
 */
export function ChannelLinksBar({ channelId, teamSlug, dm, canEdit, slot }: { channelId: string; teamSlug: string; dm: boolean; canEdit: boolean; slot: HTMLElement | null }) {
  const list = useQuery(`channel-links:${channelId}`, () => fetchChannelLinks(channelId));
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = list.status === 'ok' ? list.data.items : [];
  // on a phone the button is not in the header: the details menu carries "Add a link" (P34-05)
  useHeaderItem(channelId, canEdit && slot ? { key: 'link', label: 'Add a link', testId: 'details-bookmark-add', popup: true } : null, () => setAdding(true));

  const remove = async (b: ChannelBookmark): Promise<void> => {
    setError(null);
    try {
      await removeChannelLink(channelId, b.id);
      list.reload();
    } catch {
      setError('Could not remove the link.');
    }
  };

  return (
    <>
      {canEdit && slot
        ? createPortal(
            <button type="button" className="icon-btn bm-open" aria-label="Add a link" title="Add a link" onClick={() => setAdding(true)} data-testid="bookmark-add">
              <ToolLinkIcon />
            </button>,
            slot,
          )
        : null}
      {items.length > 0 ? (
        <div className="bmbar" role="region" aria-label="Channel links" data-testid="bookmarks-bar">
          <ul className="bm-list">
            {items.map((b) => {
              const to = channelLinkHref(b, teamSlug);
              return (
                <li key={b.id} className="bm" data-testid="bookmark" data-kind={b.kind}>
                  {to === null ? (
                    <span className="bm-link off">{b.title}</span>
                  ) : to.external ? (
                    <a className="bm-link" href={to.href} target="_blank" rel="noopener noreferrer" title={`${KIND_LABEL[b.kind]}: ${b.target}`}>{b.title}</a>
                  ) : (
                    <Link className="bm-link" to={to.href} title={`${KIND_LABEL[b.kind]}: ${b.target}`}>{b.title}</Link>
                  )}
                  {canEdit ? (
                    <button type="button" className="bm-x" aria-label={`Remove link ${b.title}`} title="Remove" onClick={() => void remove(b)}><CloseIcon size={10} /></button>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {error ? <span className="bm-error" role="alert">{error}</span> : null}
        </div>
      ) : null}
      {adding ? (
        <AddChannelLinkDialog
          channelId={channelId}
          dm={dm}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            list.reload();
          }}
        />
      ) : null}
    </>
  );
}

function AddChannelLinkDialog({ channelId, dm, onClose, onAdded }: { channelId: string; dm: boolean; onClose: () => void; onAdded: () => void }) {
  const [kind, setKind] = useState<BookmarkKind>('link');
  const [target, setTarget] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const files = useQuery(`bookmark-files:${channelId}`, () => fetchChannelFiles(channelId).catch(() => ({ items: [], nextCursor: null })));
  const fileItems = files.status === 'ok' ? files.data.items : [];

  const save = async (): Promise<void> => {
    if (busy || target.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      await addChannelLink(channelId, { kind, target: target.trim(), ...(title.trim() === '' ? {} : { title: title.trim() }) });
      onAdded();
    } catch (e) {
      setBusy(false);
      setError(isApiError(e) && e.status === 409 ? 'That is already there, or the channel has the most links it keeps.' : isApiError(e) && e.status === 400 ? 'That does not look right. Check the address or the path.' : 'Could not add the link. Try again.');
    }
  };

  return (
    <Dialog
      title="Add a link"
      onClose={onClose}
      testId="bookmark-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || target.trim() === ''} onClick={() => void save()} data-testid="bookmark-save">{busy ? 'Adding…' : 'Add'}</button>
        </>
      }
    >
      <div className="bm-kinds" role="radiogroup" aria-label="What to add">
        {(['link', 'file', ...(dm ? [] : ['page'])] as BookmarkKind[]).map((k) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} className={`bm-kind ${kind === k ? 'on' : ''}`} onClick={() => { setKind(k); setTarget(''); }}>
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>
      {kind === 'file' ? (
        <>
          <label className="fwd-label" htmlFor="bm-file">File in this channel</label>
          <select id="bm-file" className="fwd-filter" value={target} onChange={(e) => { setTarget(e.target.value); const f = fileItems.find((x) => x.id === e.target.value); if (f && title === '') setTitle(f.name); }}>
            <option value="">{files.status === 'loading' ? 'Loading…' : fileItems.length === 0 ? 'No files in this channel yet' : 'Choose a file'}</option>
            {fileItems.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </>
      ) : (
        <>
          <label className="fwd-label" htmlFor="bm-target">{kind === 'link' ? 'Web address' : 'Page path'}</label>
          <input
            id="bm-target"
            className="fwd-filter"
            type={kind === 'link' ? 'url' : 'text'}
            placeholder={kind === 'link' ? 'https://example.com/guide' : 'pages/handbook.md'}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            autoComplete="off"
            data-autofocus
          />
        </>
      )}
      <label className="fwd-label" htmlFor="bm-title">Name (optional)</label>
      <input id="bm-title" className="fwd-filter" type="text" maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="off" />
      {error ? <p className="fwd-error" role="alert">{error}</p> : null}
    </Dialog>
  );
}
