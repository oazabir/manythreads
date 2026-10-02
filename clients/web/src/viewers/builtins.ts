import { registerViewer } from '../kernel/viewers';

/*
 * The built-in viewers (`provider.viewer` contributions of the files plugin). Every component is a dynamic import, so the main
 * bundle holds only this table; Tiptap, pdf.js, highlight.js and Mermaid load when a file of that kind is opened.
 */

const CODE_EXT = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'yaml', 'yml', 'toml', 'ini', 'css', 'html', 'xml', 'py', 'go', 'rs', 'sh', 'bash', 'sql', 'diff', 'patch', 'txt', 'log'];
const OFFICE_EXT = ['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'odt', 'ods', 'odp'];

registerViewer({
  id: 'download', label: 'File', priority: -100, fallback: true, match: {}, input: 'url',
  load: () => import('./DownloadCard'),
});
registerViewer({
  id: 'code', label: 'Code', priority: 0, input: 'text',
  match: { ext: CODE_EXT, mime: ['text/*', 'application/json', 'application/yaml', 'application/toml', 'application/sql'] },
  load: () => import('./CodeViewer'),
});
registerViewer({
  id: 'markdown', label: 'Page', priority: 10, input: 'text', editable: true,
  match: { ext: ['md', 'markdown'], mime: ['text/markdown'] },
  load: () => import('./markdown/MarkdownViewer'),
});
registerViewer({
  id: 'google-link', label: 'Google link', priority: 50, input: 'text',
  match: { ext: ['md', 'markdown'], mime: ['text/markdown'], frontmatter: ['google'] },
  load: () => import('./GoogleLinkCard'),
});
registerViewer({
  id: 'csv', label: 'Table', priority: 10, input: 'text', editable: true,
  match: { ext: ['csv', 'tsv'], mime: ['text/csv', 'text/tab-separated-values'] },
  load: () => import('./CsvViewer'),
});
registerViewer({
  id: 'mermaid', label: 'Diagram', priority: 20, input: 'text',
  match: { ext: ['mmd', 'mermaid'], mime: ['text/vnd.mermaid'] },
  load: () => import('./MermaidViewer'),
});
registerViewer({
  id: 'pdf', label: 'PDF', priority: 10, input: 'url',
  match: { ext: ['pdf'], mime: ['application/pdf'] },
  load: () => import('./PdfViewer'),
});
registerViewer({
  id: 'image', label: 'Image', priority: 10, input: 'url',
  match: { ext: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg'], mime: ['image/*'] },
  load: () => import('./MediaViewers').then((m) => ({ default: m.ImageViewer })),
});
registerViewer({
  id: 'video', label: 'Video', priority: 10, input: 'url',
  match: { ext: ['mp4', 'webm', 'mov'], mime: ['video/*'] },
  load: () => import('./MediaViewers').then((m) => ({ default: m.VideoViewer })),
});
registerViewer({
  id: 'audio', label: 'Audio', priority: 10, input: 'url',
  match: { ext: ['mp3', 'wav', 'ogg', 'm4a'], mime: ['audio/*'] },
  load: () => import('./MediaViewers').then((m) => ({ default: m.AudioViewer })),
});
registerViewer({
  id: 'office', label: 'Office', priority: 10, input: 'url',
  match: { ext: OFFICE_EXT },
  load: () => import('./OfficeViewer'),
});
registerViewer({
  id: 'app', label: 'App', priority: 30, input: 'url',
  match: { folder: { has: ['index.html'], lacks: ['index.md'] } },
  load: () => import('./app/AppViewer'),
});
