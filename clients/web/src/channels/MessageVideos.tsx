import type { FileSummary } from '@manythreads/shared';
import { fileContentUrl } from '../api/endpoints';

/*
 * A video attached to a message (a screen recording, owner 2026-11-23) plays where it is, with the browser's own controls and a download link; it loads only
 * its first frame and length until it is played.
 */
const PLAYABLE: ReadonlySet<string> = new Set(['video/mp4', 'video/webm']);
export const isPlayableVideo = (file: FileSummary): boolean => PLAYABLE.has(file.mime);

export function MessageVideos({ files }: { files: readonly FileSummary[] }) {
  if (files.length === 0) return null;
  return (
    <div className="msg-videos">
      {files.map((f) => (
        <figure key={f.id} className="msg-video" data-testid="message-video">
          <video src={fileContentUrl(f.id)} controls preload="metadata" playsInline aria-label={f.name} />
          <figcaption>
            <span className="msg-video-name">{f.name}</span>
            <a href={`${fileContentUrl(f.id)}?download=1`} download={f.name}>Download</a>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}
