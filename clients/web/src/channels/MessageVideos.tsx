import { useState } from 'react';
import type { FileSummary } from '@manythreads/shared';
import { fileContentUrl } from '../api/endpoints';

/*
 * A video attached to a message (a screen recording, owner 2026-11-23) plays where it is, with the browser's own controls and a download link; it loads only
 * its first frame and length until it is played.
 */
const PLAYABLE: ReadonlySet<string> = new Set(['video/mp4', 'video/webm']);
export const isPlayableVideo = (file: FileSummary): boolean => PLAYABLE.has(file.mime);

/** One video: the player, or, when this browser cannot play it (a Chromium build without H.264, for one), a plain line with the download. */
function Video({ file }: { file: FileSummary }) {
  const [failed, setFailed] = useState(false);
  return (
    <figure className="msg-video" data-testid="message-video" data-failed={failed || undefined}>
      {failed ? (
        <p className="msg-video-cannot">This browser cannot play this video. Download it to watch it.</p>
      ) : (
        <video src={fileContentUrl(file.id)} controls preload="metadata" playsInline aria-label={file.name} onError={() => setFailed(true)} />
      )}
      <figcaption>
        <span className="msg-video-name">{file.name}</span>
        <a href={`${fileContentUrl(file.id)}?download=1`} download={file.name}>Download</a>
      </figcaption>
    </figure>
  );
}

export function MessageVideos({ files }: { files: readonly FileSummary[] }) {
  if (files.length === 0) return null;
  return (
    <div className="msg-videos">
      {files.map((f) => (
        <Video key={f.id} file={f} />
      ))}
    </div>
  );
}
