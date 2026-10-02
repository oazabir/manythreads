import type { ViewerProps } from '../kernel/viewers';
import { baseName } from './mime';

/** The last resort: a file no viewer opens, or an Office file without a PDF rendition. */
export default function DownloadCard({ path, mime, url, note }: ViewerProps & { note?: string }) {
  const name = baseName(path);
  return (
    <div className="vw download" data-testid="viewer-download">
      <div className="dl-card">
        <span className="dl-icon" aria-hidden="true">{(name.split('.').pop() ?? '').slice(0, 4).toUpperCase() || 'FILE'}</span>
        <div className="dl-text">
          <p className="dl-name">{name}</p>
          <p className="dl-note">{note ?? 'There is no preview for this kind of file.'}</p>
          <p className="dl-mime">{mime}</p>
        </div>
        {url ? <a className="btn primary sm" href={url} download={name}>Download</a> : null}
      </div>
    </div>
  );
}
