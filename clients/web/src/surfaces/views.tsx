import type { ReactNode } from 'react';
import { HeadingComponent, StackComponent, TextComponent } from '@manythreads/shared';

// How each registered part is drawn (PLAN P9-03). A view gets props the checker already passed through the part's own schema, and reads them through that
// schema again, so a view can never be handed a shape it did not expect. Text is always drawn as text: nothing a bot writes is read as markup, and no view
// sets `dangerouslySetInnerHTML`, makes a link or loads an address. P9-05 adds the other parts here.

export type SurfaceView = (input: { props: Record<string, unknown>; children: ReactNode }) => ReactNode;

const stack: SurfaceView = ({ props, children }) => {
  const p = StackComponent.props.parse(props) as { gap?: string };
  return <div className={`sf-stack sf-gap-${p.gap ?? 'medium'}`}>{children}</div>;
};

const heading: SurfaceView = ({ props }) => {
  const p = HeadingComponent.props.parse(props) as { text: string; level?: number };
  const level = p.level ?? 2;
  return (
    <div className={`sf-heading sf-heading-${level}`} role="heading" aria-level={level + 2}>
      {p.text}
    </div>
  );
};

const text: SurfaceView = ({ props }) => {
  const p = TextComponent.props.parse(props) as { text: string; tone?: string };
  return <p className={`sf-text sf-tone-${p.tone ?? 'normal'}`}>{p.text}</p>;
};

/** The drawing for each registered name. A registered name with no drawing here (a newer server) is shown as a card, never skipped silently. */
export const SURFACE_VIEWS: ReadonlyMap<string, SurfaceView> = new Map<string, SurfaceView>([
  ['Stack', stack],
  ['Heading', heading],
  ['Text', text],
]);
