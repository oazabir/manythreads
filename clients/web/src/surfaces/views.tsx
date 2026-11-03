import { createContext, useContext, type ReactNode } from 'react';
import { ButtonComponent, HeadingComponent, StackComponent, TextComponent } from '@manythreads/shared';

// How each registered part is drawn (PLAN P9-03). A view gets props the checker already passed through the part's own schema, and reads them through that
// schema again, so a view can never be handed a shape it did not expect. Text is always drawn as text: nothing a bot writes is read as markup, and no view
// sets `dangerouslySetInnerHTML`, makes a link or loads an address. P9-05 adds the other parts here.
//
// A part that can be answered (a Button, P9-04) does not send anything itself: it calls the `send` the page put in `SurfaceActions`. That is the only door out of
// a surface, and what goes through it is `{ nodeId, name, payload }` - an event name and data, never a tool, an address or a command.

export type SurfaceView = (input: { props: Record<string, unknown>; children: ReactNode; nodeId: string }) => ReactNode;

/** What a drawn surface can do for its viewer. Without a provider (a preview, a draft, a person who may not post) answerable parts are drawn but cannot be pressed. */
export interface SurfaceActions {
  /** Sends one event to the bot. Rejects with a sentence the viewer can read when it was refused. */
  send: ((nodeId: string, name: string, payload: Record<string, unknown>) => Promise<void>) | null;
  /** The parts already answered on this version of the screen (a press that went through). */
  answered: ReadonlySet<string>;
  /** A press is on its way. */
  busy: boolean;
}
const NO_ACTIONS: SurfaceActions = { send: null, answered: new Set(), busy: false };
export const SurfaceActionsContext = createContext<SurfaceActions>(NO_ACTIONS);

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

function ButtonView({ props, nodeId }: { props: Record<string, unknown>; nodeId: string }): ReactNode {
  const p = ButtonComponent.props.parse(props) as { label: string; tone?: string };
  const actions = useContext(SurfaceActionsContext);
  const done = actions.answered.has(nodeId);
  return (
    <button
      type="button"
      className={`btn s sf-button${p.tone === 'primary' ? ' primary' : ''}`}
      data-testid="surface-button"
      data-node={nodeId}
      disabled={actions.send === null || actions.busy || done}
      aria-pressed={done ? true : undefined}
      onClick={() => {
        if (actions.send !== null) void actions.send(nodeId, 'press', {});
      }}
    >
      {p.label}
      {done ? <span className="sf-button-done"> (sent)</span> : null}
    </button>
  );
}

const button: SurfaceView = ({ props, nodeId }) => <ButtonView props={props} nodeId={nodeId} />;

/** The drawing for each registered name. A registered name with no drawing here (a newer server) is shown as a card, never skipped silently. */
export const SURFACE_VIEWS: ReadonlyMap<string, SurfaceView> = new Map<string, SurfaceView>([
  ['Stack', stack],
  ['Heading', heading],
  ['Text', text],
  ['Button', button],
]);
