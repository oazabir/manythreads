import { lazy, Suspense } from 'react';
import type { ViewerProps } from '../kernel/viewers';
import DownloadCard from './DownloadCard';
import { ViewerMessage } from './common';

const PdfViewer = lazy(() => import('./PdfViewer'));

/**
 * Office files are read-only here: with a PDF rendition (the optional converter made one) the PDF viewer shows it; without one
 * the person gets a download card that says so.
 */
export default function OfficeViewer(props: ViewerProps) {
  if (props.renditionUrl) {
    return (
      <Suspense fallback={<ViewerMessage title="Loading preview" />}>
        <PdfViewer {...props} mime="application/pdf" url={props.renditionUrl} downloadUrl={props.url} />
      </Suspense>
    );
  }
  return <DownloadCard {...props} note="Preview is not available for Office files here. Download it to open it in Office." />;
}
