import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FileSummary } from '@manythreads/shared';
import { fileContentUrl } from '../api/endpoints';

/*
 * Pictures in the chat (PLAN P3-13's message row): an image attachment is drawn as a small, cropped preview instead of a file card,
 * several of them as a grid, and a press opens the full picture on a scrim with a Download button in its corner. The preview is a
 * `<img>` laid out small and decoded lazily; the bytes are the stored file (the files route has no resized variant), so a channel of
 * pictures stays affordable rather than free. Esc or a press on the scrim closes, and focus returns to the thumbnail that opened it.
 */

function Lightbox({ file, onClose }: { file: FileSummary; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    opener.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      // capture, like Dialog: the panel behind stays open until the next press
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      opener.current?.focus?.();
    };
  }, [onClose]);

  return createPortal(
    <div className="imgbox-scrim" data-testid="image-lightbox" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="imgbox" role="dialog" aria-modal="true" aria-label={file.name}>
        <img src={fileContentUrl(file.id)} alt={file.name} />
        <button ref={closeRef} type="button" className="imgbox-close" aria-label="Close image" onClick={onClose}>
          ×
        </button>
        <div className="imgbox-foot">
          <p className="imgbox-name">{file.name}</p>
          <a className="imgbox-dl" href={`${fileContentUrl(file.id)}?download=1`} download={file.name} data-testid="image-download">
            Download
          </a>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** A message's pictures: one wide preview, or a grid of thumbnails, each opening the full image. */
export function MessageImages({ files }: { files: FileSummary[] }) {
  const [openAt, setOpenAt] = useState<number | null>(null);
  const close = useCallback(() => setOpenAt(null), []);
  if (files.length === 0) return null;
  const current = openAt === null ? null : (files[openAt] ?? null);

  return (
    <>
      <div
        className="msg-imgs"
        data-testid="message-images"
        data-count={files.length}
        data-layout={files.length === 1 ? 'single' : 'grid'}
        role="group"
        aria-label={files.length === 1 ? 'Image' : `${files.length} images`}
      >
        {files.map((file, i) => (
          <button
            key={file.id}
            type="button"
            className="msg-img"
            data-testid="message-image"
            aria-label={`Open ${file.name}`}
            onClick={() => setOpenAt(i)}
          >
            <img src={fileContentUrl(file.id)} alt={file.name} loading="lazy" decoding="async" />
          </button>
        ))}
      </div>
      {current ? <Lightbox file={current} onClose={close} /> : null}
    </>
  );
}
