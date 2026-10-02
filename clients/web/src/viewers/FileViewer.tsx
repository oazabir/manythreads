import { Component, Suspense, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import { repoAppPath, type ViewerSubject } from '@manythreads/shared';
import { viewerRegistry, type ViewerContext, type ViewerDef, type ViewerRegistry } from '../kernel/viewers';
import './builtins';
import { ViewerMessage } from './common';
import { frontmatterKeys, splitFrontmatter } from './frontmatter';
import { mimeForPath } from './mime';
import type { ContentSource } from './source';

export type FileViewerProps = {
  /** Repo path of the file (or folder). */
  path: string;
  /** The store's mime type when it has one; otherwise the extension decides. */
  mime?: string | undefined;
  kind?: 'file' | 'folder';
  /** The names a folder holds (an app folder is recognised by them). */
  entries?: readonly string[];
  source: ContentSource;
  readOnly?: boolean;
  onSave?: (text: string) => Promise<void>;
  context: ViewerContext;
  /** An Office file's PDF rendition. */
  renditionUrl?: string;
  /** Where an embedded app is served; defaults to the content route of the team. */
  appUrl?: string;
  registry?: ViewerRegistry;
  /** Changes when the file's content changed on the server, so an open viewer starts over from the new text. */
  version?: string | number;
};

type Loaded = { def: ViewerDef | null; text?: string; bytes?: Uint8Array };

async function resolve(props: FileViewerProps, registry: ViewerRegistry): Promise<Loaded> {
  const subject: ViewerSubject = {
    path: props.path,
    mime: props.mime || mimeForPath(props.path),
    kind: props.kind ?? 'file',
    entries: props.entries,
  };
  let def = registry.pick(subject) ?? null;
  const out: Loaded = { def };
  const load = async (input: ViewerDef['input']) => {
    if (input === 'text' && out.text === undefined) out.text = await props.source.text();
    if (input === 'bytes' && out.bytes === undefined) out.bytes = await props.source.bytes();
  };
  // a page's frontmatter can change which viewer opens it (`google:` shows a link card), so read the text first when one cares
  if (def?.input === 'text' && registry.list().some((d) => d.match.frontmatter)) {
    await load('text');
    const keys = frontmatterKeys(splitFrontmatter(out.text ?? '').frontmatter);
    def = registry.pick({ ...subject, frontmatterKeys: keys }) ?? def;
    out.def = def;
  }
  if (def) await load(def.input);
  return out;
}

/** A viewer that throws while drawing shows a message instead of taking the panel down. */
class ViewerBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('viewer error', error, info.componentStack);
  }
  render(): ReactNode {
    return this.state.failed ? <ViewerMessage title="This file could not be shown" tone="alert">Reload the panel, or download the file.</ViewerMessage> : this.props.children;
  }
}

/**
 * The host of the viewers: picks the viewer for a path (registry, `provider.viewer`), gives it the form of content it asks for, and
 * draws it lazily. It renders the panel entry `file:<path>` and fills the preview slot of the Files screen.
 */
export function FileViewer(props: FileViewerProps) {
  const registry = props.registry ?? viewerRegistry;
  const [state, setState] = useState<{ status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; loaded: Loaded }>({ status: 'loading' });
  const { path, version, source, kind, entries, mime } = props;
  const entriesKey = entries?.join('\0');

  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    resolve({ ...props }, registry).then(
      (loaded) => alive && setState({ status: 'ready', loaded }),
      (err: unknown) => alive && setState({ status: 'error', message: err instanceof Error && err.message ? err.message : 'The file could not be loaded.' }),
    );
    return () => {
      alive = false;
    };
    // `props` is read once per file: a new path, version or source restarts the load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, version, source, kind, entriesKey, mime, registry]);

  if (state.status === 'loading') return <div className="vw-loading" role="status" aria-busy="true">Loading…</div>;
  if (state.status === 'error') return <ViewerMessage title={state.message} tone="alert" />;
  const { def, text, bytes } = state.loaded;
  if (!def) return <ViewerMessage title="No viewer for this file" />;
  const View = registry.component(def);
  const url = def.input === 'url' ? ((props.kind ?? 'file') === 'folder' ? (props.appUrl ?? repoAppPath(props.context.teamSlug, props.path)) : props.source.url) : undefined;
  return (
    <div className="fv" data-testid="file-viewer" data-viewer={def.id}>
      <ViewerBoundary>
        <Suspense fallback={<div className="vw-loading" role="status" aria-busy="true">Loading viewer…</div>}>
          <View
            key={`${props.path}:${props.version ?? ''}`}
            path={props.path}
            mime={props.mime || mimeForPath(props.path)}
            {...(text !== undefined ? { text } : {})}
            {...(bytes !== undefined ? { bytes } : {})}
            {...(url ? { url } : {})}
            readOnly={props.readOnly === true || !props.onSave}
            {...(props.onSave ? { onSave: props.onSave } : {})}
            context={props.context}
            {...(props.renditionUrl ? { renditionUrl: props.renditionUrl } : {})}
          />
        </Suspense>
      </ViewerBoundary>
    </div>
  );
}
