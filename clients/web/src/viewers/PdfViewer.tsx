import { useEffect, useRef, useState } from 'react';
// The legacy build runs on the WebViews the Capacitor and Tauri shells use (the modern one needs very recent engine features).
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
// The worker is a file of this build (an asset of our origin), never a CDN.
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { ViewerProps } from '../kernel/viewers';
import { ViewerMessage } from './common';
import { baseName } from './mime';

GlobalWorkerOptions.workerSrc = workerUrl;

const ZOOMS = [50, 75, 100, 125, 150, 200, 300];

/**
 * PDF with pdf.js: toolbar `[< 3/12 >] [- 100% +] [download]`, one page at a time on a canvas. 100% fits the page to the width of the
 * viewer. The document is read from `url` with the session cookie (same origin); nothing here leaves the page.
 */
export default function PdfViewer({ path, url, downloadUrl }: ViewerProps & { downloadUrl?: string | undefined }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(100);
  const [width, setWidth] = useState(0);
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!url) {
      setError('This PDF has no address to load from.');
      return;
    }
    let alive = true;
    const task = getDocument({ url, withCredentials: true });
    task.promise.then(
      (d) => {
        if (alive) setDoc(d);
      },
      () => alive && setError('This PDF could not be opened.'),
    );
    return () => {
      alive = false;
      void task.destroy();
    };
  }, [url]);

  // measure the holder: 100% means "fit the width"
  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const read = () => setWidth(el.clientWidth);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!doc || !canvas.current || width === 0) return;
    let alive = true;
    let task: RenderTask | null = null;
    void doc
      .getPage(page)
      .then(async (p) => {
        if (!alive || !canvas.current) return;
        const base = p.getViewport({ scale: 1 });
        const scale = ((width - 2) / base.width) * (zoom / 100);
        const ratio = window.devicePixelRatio || 1;
        const viewport = p.getViewport({ scale: scale * ratio });
        const el = canvas.current;
        el.width = Math.floor(viewport.width);
        el.height = Math.floor(viewport.height);
        el.style.width = `${Math.floor(viewport.width / ratio)}px`;
        el.style.height = `${Math.floor(viewport.height / ratio)}px`;
        task = p.render({ canvas: el, viewport });
        await task.promise;
        if (alive) el.dataset['rendered'] = String(page);
      })
      .catch((err: unknown) => {
        if (alive && !(err instanceof Error && err.name === 'RenderingCancelledException')) setError('This page could not be drawn.');
      });
    return () => {
      alive = false;
      task?.cancel();
    };
  }, [doc, page, zoom, width]);

  if (error) return <ViewerMessage title={error} tone="alert">{url ? <a href={downloadUrl ?? url} download={baseName(path)}>Download it</a> : null}</ViewerMessage>;
  const pages = doc?.numPages ?? 0;
  const go = (n: number) => setPage(Math.min(Math.max(1, n), Math.max(1, pages)));
  const zoomBy = (dir: 1 | -1) => {
    const i = ZOOMS.indexOf(zoom);
    setZoom(ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, i + dir))] ?? 100);
  };
  return (
    <div
      className="vw pdf"
      data-testid="viewer-pdf"
      data-pages={pages}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'PageDown') go(page + 1);
        else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(page - 1);
      }}
    >
      <div className="pdf-bar" role="toolbar" aria-label="PDF controls">
        <button type="button" className="btn sm" aria-label="Previous page" disabled={page <= 1} onClick={() => go(page - 1)}>&lt;</button>
        <span className="pdf-page" data-testid="pdf-page" aria-live="polite">{doc ? `${page}/${pages}` : '…'}</span>
        <button type="button" className="btn sm" aria-label="Next page" disabled={!doc || page >= pages} onClick={() => go(page + 1)}>&gt;</button>
        <span className="pdf-gap" />
        <button type="button" className="btn sm" aria-label="Zoom out" disabled={zoom <= ZOOMS[0]!} onClick={() => zoomBy(-1)}>-</button>
        <span className="pdf-zoom" data-testid="pdf-zoom">{zoom}%</span>
        <button type="button" className="btn sm" aria-label="Zoom in" disabled={zoom >= ZOOMS[ZOOMS.length - 1]!} onClick={() => zoomBy(1)}>+</button>
        <span className="pdf-gap" />
        {url ? <a className="btn sm" href={downloadUrl ?? url} download={baseName(path)}>Download</a> : null}
      </div>
      <div className="pdf-holder" ref={holder} aria-busy={!doc}>
        <canvas ref={canvas} className="pdf-canvas" data-testid="pdf-canvas" role="img" aria-label={`Page ${page} of ${baseName(path)}`} />
      </div>
    </div>
  );
}
