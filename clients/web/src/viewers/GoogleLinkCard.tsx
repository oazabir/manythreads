import type { ViewerProps } from '../kernel/viewers';
import { ViewerMessage } from './common';
import { isGoogleHost, parseGoogleLink, splitFrontmatter } from './frontmatter';
import { baseName } from './mime';

const KIND: Record<string, string> = { doc: 'Google Doc', docs: 'Google Doc', sheet: 'Google Sheet', sheets: 'Google Sheet', slides: 'Google Slides', slide: 'Google Slides' };

const kindFromUrl = (url: string): string => {
  if (url.includes('/document/')) return 'Google Doc';
  if (url.includes('/spreadsheets/')) return 'Google Sheet';
  if (url.includes('/presentation/')) return 'Google Slides';
  return 'Google file';
};

/**
 * A page whose frontmatter has `google:` is a pointer, not a copy: this card previews the link and opens Google in a new tab.
 * Nothing is embedded (SPEC 5.2: no live editing of Google files inside manythreads).
 */
export default function GoogleLinkCard({ path, text = '' }: ViewerProps) {
  const link = parseGoogleLink(splitFrontmatter(text).frontmatter);
  if (!link || !isGoogleHost(link.url)) {
    return <ViewerMessage title="This link is not a Google file" tone="alert">The google: entry in the page header needs a https://docs.google.com or https://drive.google.com address.</ViewerMessage>;
  }
  const kind = (link.kind && KIND[link.kind.toLowerCase()]) || kindFromUrl(link.url);
  const host = new URL(link.url).hostname;
  return (
    <div className="vw gcard" data-testid="viewer-google">
      <div className="gc-card">
        <span className="gc-kind">{kind}</span>
        <p className="gc-title">{link.title ?? baseName(path).replace(/\.md$/, '')}</p>
        <p className="gc-host">{host}</p>
        <a className="btn primary sm" href={link.url} target="_blank" rel="noopener noreferrer">Open in Google</a>
      </div>
      <p className="vw-note">This is a link preview. The file stays in Google and is not embedded here.</p>
    </div>
  );
}
