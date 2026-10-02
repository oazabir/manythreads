import { useState } from 'react';
import type { ViewerProps } from '../kernel/viewers';
import { ViewerMessage } from './common';
import { baseName } from './mime';

/** Image: scaled to the width, never upscaled past its own size. SVG goes through `<img>`, where scripts do not run. */
export function ImageViewer({ path, url }: ViewerProps) {
  const [failed, setFailed] = useState(false);
  if (failed || !url) return <ViewerMessage title="This image could not be shown" tone="alert">Download it to open it elsewhere.</ViewerMessage>;
  return (
    <div className="vw media" data-testid="viewer-image">
      <img className="media-img" src={url} alt={baseName(path)} onError={() => setFailed(true)} />
    </div>
  );
}

export function VideoViewer({ path, url }: ViewerProps) {
  const [failed, setFailed] = useState(false);
  if (!url) return <ViewerMessage title="This video could not be played" tone="alert" />;
  return (
    <div className="vw media" data-testid="viewer-video">
      <video className="media-video" src={url} controls preload="metadata" aria-label={baseName(path)} onError={() => setFailed(true)} />
      {failed ? (
        <p className="vw-error" role="alert">
          This browser cannot play this video. <a href={url} download={baseName(path)}>Download it</a>
        </p>
      ) : null}
    </div>
  );
}

export function AudioViewer({ path, url }: ViewerProps) {
  const [failed, setFailed] = useState(false);
  if (!url) return <ViewerMessage title="This audio could not be played" tone="alert" />;
  return (
    <div className="vw media" data-testid="viewer-audio">
      <p className="media-name">{baseName(path)}</p>
      <audio className="media-audio" src={url} controls preload="metadata" aria-label={baseName(path)} onError={() => setFailed(true)} />
      {failed ? (
        <p className="vw-error" role="alert">
          This browser cannot play this audio. <a href={url} download={baseName(path)}>Download it</a>
        </p>
      ) : null}
    </div>
  );
}
