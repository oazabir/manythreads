import { useMemo, useState } from 'react';
import { FileViewer } from '../viewers/FileViewer';
import { httpSource } from '../viewers/source';

/*
 * Developer page: every viewer on its own fixture (e2e/fixtures/files, served by the dev and preview server under /__dev/files).
 * Saves stay in the page (shown under the viewer) so specs can read exactly what a viewer would write.
 */

const context = { teamSlug: '_dev', teamName: 'Engineering', authorName: 'Tariq' };
const file = (name: string) => `/__dev/files/${name}`;

type Tile = {
  id: string;
  title: string;
  path: string;
  src?: string;
  folder?: string[];
  rendition?: string;
  editable?: boolean;
  tall?: boolean;
};

const TILES: Tile[] = [
  { id: 'markdown', title: 'Markdown page', path: 'pages/reports/week-37.md', src: 'page.md', editable: true, tall: true },
  { id: 'google', title: 'Google link', path: 'pages/planning.md', src: 'google.md' },
  { id: 'csv', title: 'CSV', path: 'pages/reports/signups.csv', src: 'signups.csv', editable: true },
  { id: 'pdf', title: 'PDF', path: 'pages/handbook.pdf', src: 'sample.pdf', tall: true },
  { id: 'image', title: 'Image', path: 'channels/dev/sample.png', src: 'sample.png' },
  { id: 'video', title: 'Video (WebM)', path: 'channels/dev/sample.webm', src: 'sample.webm' },
  { id: 'audio', title: 'Audio', path: 'channels/dev/sample.wav', src: 'sample.wav' },
  { id: 'code', title: 'Code', path: 'src/sample.ts', src: 'sample.ts' },
  { id: 'mermaid', title: 'Mermaid', path: 'pages/architecture.mmd', src: 'diagram.mmd', tall: true },
  { id: 'mermaid-error', title: 'Mermaid with a syntax error', path: 'pages/broken.mmd', src: 'broken.mmd' },
  { id: 'office', title: 'Office (no rendition)', path: 'channels/dev/report.docx', src: 'report.docx' },
  { id: 'office-pdf', title: 'Office (PDF rendition)', path: 'channels/dev/report.docx', src: 'report.docx', rendition: file('sample.pdf'), tall: true },
  { id: 'app', title: 'Embedded app', path: 'apps/release-checklist', folder: ['index.html'], tall: true },
  { id: 'unknown', title: 'No viewer', path: 'channels/dev/archive.bin', src: 'report.docx' },
];

export function DevViewers() {
  const [saves, setSaves] = useState<Record<string, string>>({});
  const sources = useMemo(() => Object.fromEntries(TILES.map((t) => [t.id, httpSource(file(t.src ?? 'sample.ts'))])), []);
  return (
    <div className="dev dev-viewers" data-testid="app-frame">
      <h1>Viewers</h1>
      <p className="lede">Developer page. Every viewer on a fixture file; saves are kept here, nothing is written.</p>
      <div className="dev-viewer-grid">
        {TILES.map((t) => (
          <section key={t.id} className="dev-viewer" data-testid={`dev-viewer-${t.id}`} aria-label={t.title}>
            <h2>{t.title}</h2>
            <div className={`dev-viewer-body${t.tall ? ' tall' : ''}`}>
              <FileViewer
                path={t.path}
                {...(t.folder ? { kind: 'folder' as const, entries: t.folder } : {})}
                source={sources[t.id] ?? httpSource(file('sample.ts'))}
                context={context}
                {...(t.rendition ? { renditionUrl: t.rendition } : {})}
                {...(t.editable
                  ? {
                      onSave: (text: string) => {
                        setSaves((s) => ({ ...s, [t.id]: text }));
                        return Promise.resolve();
                      },
                    }
                  : { readOnly: true })}
              />
            </div>
            {saves[t.id] !== undefined ? <pre className="dev-saved" data-testid={`dev-saved-${t.id}`}>{saves[t.id]}</pre> : null}
          </section>
        ))}
      </div>
    </div>
  );
}
