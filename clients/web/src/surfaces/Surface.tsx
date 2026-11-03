import { Component, useMemo, useRef, type ErrorInfo, type ReactNode } from 'react';
import {
  SURFACE_REGISTRY,
  resolveSurface,
  type SurfaceNode,
  type SurfaceRegistry,
  type SurfaceRejectionCode,
  type SurfaceTree,
} from '@manythreads/shared';
import { advanceSurfaceFeed, type SurfaceFeed } from './stream';
import { BoundPart } from './BoundPart';
import { SURFACE_VIEWS, type SurfaceView } from './views';

/*
 * The surface renderer (PLAN P9-03, SPEC §14). A bot writes a screen as text; this draws it. The text may still be arriving: pass the whole text so far
 * and `ended: false`, and the page draws what has arrived with a placeholder for each part still to come. Every part is checked before it is drawn
 * (packages/shared/src/surfaces): an unknown name or props that do not fit become a card that says so, in place of that part only, and the rest of the
 * screen stays. Nothing here ever draws a part that did not pass the check.
 */

const CODE_TITLE: Record<SurfaceRejectionCode, string> = {
  syntax: 'This part could not be read',
  unknown_component: 'This part is not available',
  invalid_props: 'This part has values it cannot use',
  unresolved_ref: 'This part is missing',
  cycle: 'This part contains itself',
  too_deep: 'This part is nested too deeply',
  too_large: 'This part is too large',
  duplicate: 'This part was written twice',
};

/** The card that stands where a part was refused. It carries the reason in plain words and nothing the bot wrote is read as markup. */
export function SurfaceRejection({ code, message, name }: { code: SurfaceRejectionCode; message: string; name?: string | null }): ReactNode {
  return (
    <div className="sf-reject" role="note" data-testid="surface-rejection" data-code={code}>
      <div className="sf-reject-title">{CODE_TITLE[code]}</div>
      <div className="sf-reject-why">{message}</div>
      {name ? <div className="sf-reject-name">{name}</div> : null}
    </div>
  );
}

function Pending(): ReactNode {
  return <span className="sf-pending" data-testid="surface-pending" aria-hidden="true" />;
}

function PartView({ node, views }: { node: SurfaceNode; views: ReadonlyMap<string, SurfaceView> }): ReactNode {
  if (node.kind === 'pending') return <Pending />;
  if (node.kind === 'rejected') return <SurfaceRejection code={node.code} message={node.message} name={node.name} />;
  const view = views.get(node.name);
  if (!view) {
    return <SurfaceRejection code="unknown_component" message={`${node.name} is not something this version of the app can draw yet`} name={node.name} />;
  }
  return <Part node={node} view={view} views={views} />;
}


/** Stops a part that fails to draw from taking the screen with it (exported for the test). */
export class PartBoundary extends Component<{ children: ReactNode; label: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('surface part failed to draw', error, info.componentStack);
  }
  render(): ReactNode {
    return this.state.failed ? <SurfaceRejection code="invalid_props" message="This part could not be drawn" name={this.props.label} /> : this.props.children;
  }
}

function ViewHost({ view, props, nodeId, children }: { view: SurfaceView; props: Record<string, unknown>; nodeId: string; children: ReactNode }): ReactNode {
  return view({ props, children, nodeId });
}

function Part({ node, view, views }: { node: Extract<SurfaceNode, { kind: 'component' }>; view: SurfaceView; views: ReadonlyMap<string, SurfaceView> }): ReactNode {
  const children = node.children.map((c) => <PartView key={c.key} node={c} views={views} />);
  // A view that throws costs that one part, not the screen.
  const draw = (props: Record<string, unknown>): ReactNode => (
    <ViewHost view={view} props={props} nodeId={node.id}>
      {children}
    </ViewHost>
  );
  return (
    <PartBoundary label={node.name}>
      {node.bind ? <BoundPart draw={draw} name={node.name} nodeId={node.id} props={node.props} bind={node.bind} /> : draw(node.props)}
    </PartBoundary>
  );
}

/** The checked tree for a text that may still be growing. Reads only what is new since the last render. */
export function useSurfaceTree(source: string, ended: boolean, registry: SurfaceRegistry = SURFACE_REGISTRY): SurfaceTree {
  const feed = useRef<SurfaceFeed | null>(null);
  return useMemo(() => {
    feed.current = advanceSurfaceFeed(feed.current, source, ended);
    return resolveSurface(feed.current.state, registry);
  }, [source, ended, registry]);
}

/** Draw an already checked tree. */
export function SurfaceTreeView({ tree, views = SURFACE_VIEWS }: { tree: SurfaceTree; views?: ReadonlyMap<string, SurfaceView> }): ReactNode {
  const { root, problems, complete } = tree;
  return (
    <div className="sf" data-testid="surface" data-complete={complete ? 'true' : 'false'} aria-busy={complete ? undefined : true}>
      {root ? (
        <PartView node={root} views={views} />
      ) : complete ? (
        <SurfaceRejection code="unresolved_ref" message={problems[0]?.message ?? 'There is nothing to show'} />
      ) : (
        <Pending />
      )}
    </div>
  );
}

/**
 * A surface from its text. Give the whole text so far; set `ended` once it is complete. Parts are drawn as they arrive, each after it passed its check.
 */
export function Surface({ source, ended = true, registry, views }: { source: string; ended?: boolean; registry?: SurfaceRegistry; views?: ReadonlyMap<string, SurfaceView> }): ReactNode {
  const tree = useSurfaceTree(source, ended, registry);
  return <SurfaceTreeView tree={tree} {...(views ? { views } : {})} />;
}
