import { createContext, useContext, type ReactNode } from 'react';
import {
  ApprovalCardComponent,
  BadgeComponent,
  ButtonComponent,
  CalloutComponent,
  ChannelLinkComponent,
  ChartComponent,
  CodeComponent,
  DiffViewComponent,
  DividerComponent,
  EntityCardComponent,
  GridComponent,
  HeadingComponent,
  ListComponent,
  PersonChipComponent,
  RowComponent,
  StackComponent,
  StatComponent,
  TableComponent,
  TextComponent,
} from '@manythreads/shared';
import { CHART_H, CHART_W, chartShape, classifyDiff, fitText, formatValue } from './draw';
import { useSurfaceHost } from './host';

// How each registered part is drawn (PLAN P9-03). A view gets props the checker already passed through the part's own schema, and reads them through that
// schema again, so a view can never be handed a shape it did not expect. Text is always drawn as text: nothing a bot writes is read as markup, and no view
// sets `dangerouslySetInnerHTML`, makes a link or loads an address. The manythreads parts (P9-05) ask the page for what an id means to the viewer (./host.ts) and fall back to a plain chip with the bot's label.
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

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info';

const stack: SurfaceView = ({ props, children }) => {
  const p = StackComponent.props.parse(props) as { gap?: string };
  return <div className={`sf-stack sf-gap-${p.gap ?? 'medium'}`}>{children}</div>;
};

const row: SurfaceView = ({ props, children }) => {
  const p = RowComponent.props.parse(props) as { gap?: string; align?: string };
  return <div className={`sf-row sf-gap-${p.gap ?? 'medium'} sf-align-${p.align ?? 'start'}`}>{children}</div>;
};

const grid: SurfaceView = ({ props, children }) => {
  const p = GridComponent.props.parse(props) as { columns?: number; gap?: string };
  return <div className={`sf-grid sf-cols-${p.columns ?? 2} sf-gap-${p.gap ?? 'medium'}`}>{children}</div>;
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

const stat: SurfaceView = ({ props }) => {
  const p = StatComponent.props.parse(props) as { label: string; value: string | number; delta?: string; tone?: Tone };
  return (
    <div className="sf-stat">
      <div className="sf-stat-label">{p.label}</div>
      <div className="sf-stat-value">{String(p.value)}</div>
      {p.delta ? <div className={`sf-stat-delta sf-ink-${p.tone ?? 'neutral'}`}>{p.delta}</div> : null}
    </div>
  );
};

const cellText = (v: string | number | boolean | null | undefined): string => (v === null || v === undefined ? '' : String(v));

function DataTable({ columns, rows, caption, className }: { columns: readonly string[]; rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null>>; caption?: string | undefined; className: string }): ReactNode {
  return (
    <table className={className}>
      {caption ? <caption>{caption}</caption> : null}
      <thead>
        <tr>
          {columns.map((c, i) => (
            <th key={i} scope="col">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {columns.map((_, j) => (
              <td key={j}>{cellText(r[j])}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const table: SurfaceView = ({ props }) => {
  const p = TableComponent.props.parse(props) as { columns: string[]; rows: Array<Array<string | number | boolean | null>>; caption?: string };
  // The table scrolls inside its own box, so a wide one never widens the page.
  return (
    <div className="sf-table-wrap" tabIndex={0} role="region" aria-label={p.caption ?? 'Table'}>
      <DataTable columns={p.columns} rows={p.rows} caption={p.caption} className="sf-table" />
    </div>
  );
};

const chart: SurfaceView = ({ props }) => {
  const p = ChartComponent.props.parse(props) as { kind: 'bar' | 'line'; labels: string[]; values: number[]; title?: string; unit?: string };
  const shape = chartShape(p.values);
  const name = p.title ?? (p.kind === 'bar' ? 'Bar chart' : 'Line chart');
  const rows = p.labels.map((l, i) => [l, p.values[i]!] as Array<string | number>);
  return (
    <figure className="sf-chart">
      {p.title ? <figcaption className="sf-chart-title">{p.title}</figcaption> : null}
      <svg className="sf-chart-svg" viewBox={`0 0 ${CHART_W} ${CHART_H}`} role="img" aria-label={`${name}: ${p.values.length} values. The same numbers are in the table below.`} focusable="false">
        <line className="sf-chart-zero" x1={0} x2={CHART_W} y1={shape.zeroY} y2={shape.zeroY} />
        {p.kind === 'bar' ? (
          shape.bars.map((b, i) => (
            <rect key={i} className="sf-chart-bar" x={b.x} y={b.y} width={b.w} height={b.h}>
              <title>{`${p.labels[i]}: ${p.values[i]}${p.unit ? ` ${p.unit}` : ''}`}</title>
            </rect>
          ))
        ) : (
          <>
            <polyline className="sf-chart-line" points={shape.line} />
            {shape.dots.map((d, i) => (
              <circle key={i} className="sf-chart-dot" cx={d.x} cy={d.y} r={2.5}>
                <title>{`${p.labels[i]}: ${p.values[i]}${p.unit ? ` ${p.unit}` : ''}`}</title>
              </circle>
            ))}
          </>
        )}
        {shape.marks.map((m, i) => {
          const value = fitText(formatValue(p.values[i]!), shape.slot * 1.3);
          const label = fitText(p.labels[i]!, shape.slot);
          return (
            <g key={i} data-testid="surface-chart-mark">
              {value ? (
                <text className="sf-chart-value" x={m.x} y={m.valueY}>
                  {value}
                </text>
              ) : null}
              {label ? (
                <text className="sf-chart-label" x={m.x} y={shape.labelY}>
                  {label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <details className="sf-chart-data">
        <summary>Show the numbers</summary>
        <div className="sf-table-wrap">
          <DataTable columns={['Name', p.unit ? `Value (${p.unit})` : 'Value']} rows={rows} caption={name} className="sf-table" />
        </div>
      </details>
    </figure>
  );
};

const list: SurfaceView = ({ props }) => {
  const p = ListComponent.props.parse(props) as { items: string[]; ordered?: boolean };
  const items = p.items.map((t, i) => (
    <li key={i} className="sf-li">
      {t}
    </li>
  ));
  return p.ordered ? <ol className="sf-list">{items}</ol> : <ul className="sf-list">{items}</ul>;
};

const badge: SurfaceView = ({ props }) => {
  const p = BadgeComponent.props.parse(props) as { text: string; tone?: Tone };
  return <span className={`sf-badge sf-tint-${p.tone ?? 'neutral'}`}>{p.text}</span>;
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

const callout: SurfaceView = ({ props }) => {
  const p = CalloutComponent.props.parse(props) as { text: string; tone?: Tone; title?: string };
  return (
    <div className={`sf-callout sf-tint-${p.tone ?? 'info'}`} role="note">
      {p.title ? <div className="sf-callout-title">{p.title}</div> : null}
      <div className="sf-callout-text">{p.text}</div>
    </div>
  );
};

const code: SurfaceView = ({ props }) => {
  const p = CodeComponent.props.parse(props) as { code: string; language?: string };
  // The language is only a label (data-language); nothing is coloured or run.
  return (
    <pre className="sf-code" tabIndex={0}>
      <code data-language={p.language}>{p.code}</code>
    </pre>
  );
};

const divider: SurfaceView = ({ props }) => {
  DividerComponent.props.parse(props);
  return <hr className="sf-divider" />;
};

function EntityCardView({ entityType, id, label, summary }: { entityType: string; id: string; label: string; summary?: string | undefined }): ReactNode {
  const found = useSurfaceHost().entity?.(entityType, id) ?? null;
  const shown = found?.label ?? label;
  const about = found ? found.summary : summary;
  return (
    <div className="sf-entity" data-entity-type={entityType} data-resolved={found ? 'true' : 'false'}>
      <span className="sf-entity-type">{entityType}</span>
      <span className="sf-entity-label">{shown}</span>
      {about ? <span className="sf-entity-summary">{about}</span> : null}
    </div>
  );
}

const entityCard: SurfaceView = ({ props }) => {
  const p = EntityCardComponent.props.parse(props) as { entityType: string; id: string; label: string; summary?: string };
  return <EntityCardView entityType={p.entityType} id={p.id} label={p.label} summary={p.summary} />;
};

function PersonChipView({ id, label }: { id: string; label: string }): ReactNode {
  const name = useSurfaceHost().personName?.(id) ?? null;
  return (
    <span className="sf-chip sf-chip-person" data-resolved={name ? 'true' : 'false'}>
      {name ?? label}
    </span>
  );
}

const personChip: SurfaceView = ({ props }) => {
  const p = PersonChipComponent.props.parse(props) as { id: string; label: string };
  return <PersonChipView id={p.id} label={p.label} />;
};

function ChannelLinkView({ id, label }: { id: string; label: string }): ReactNode {
  const host = useSurfaceHost();
  const name = host.channelName?.(id) ?? null;
  const open = host.openChannel;
  const shown = `# ${name ?? label}`;
  // A link only when the page can open the channel for this person; otherwise the same chip, not pressable.
  if (open && name) {
    return (
      <button type="button" className="sf-chip sf-chip-channel sf-chip-link" data-resolved="true" onClick={() => open(id)}>
        {shown}
      </button>
    );
  }
  return (
    <span className="sf-chip sf-chip-channel" data-resolved={name ? 'true' : 'false'}>
      {shown}
    </span>
  );
}

const channelLink: SurfaceView = ({ props }) => {
  const p = ChannelLinkComponent.props.parse(props) as { id: string; label: string };
  return <ChannelLinkView id={p.id} label={p.label} />;
};

const APPROVAL_STATUS: Record<'waiting' | 'approved' | 'declined' | 'expired', { text: string; tone: Tone }> = {
  waiting: { text: 'Waiting for a person', tone: 'warn' },
  approved: { text: 'Approved', tone: 'good' },
  declined: { text: 'Declined', tone: 'bad' },
  expired: { text: 'Expired', tone: 'neutral' },
};

function ApprovalCardView({ id, title, summary }: { id: string; title: string; summary?: string | undefined }): ReactNode {
  const status = useSurfaceHost().approvalStatus?.(id) ?? null;
  const s = status ? APPROVAL_STATUS[status] : null;
  return (
    <div className="sf-approval" data-status={status ?? 'unknown'}>
      <div className="sf-approval-head">
        <span className="sf-approval-title">{title}</span>
        {s ? <span className={`sf-badge sf-tint-${s.tone}`}>{s.text}</span> : null}
      </div>
      {summary ? <div className="sf-approval-summary">{summary}</div> : null}
      <div className="sf-approval-note">{status === 'waiting' || !status ? 'A person decides this in the approvals list.' : 'This was decided in the approvals list.'}</div>
    </div>
  );
}

const approvalCard: SurfaceView = ({ props }) => {
  const p = ApprovalCardComponent.props.parse(props) as { approvalId: string; title: string; summary?: string };
  return <ApprovalCardView id={p.approvalId} title={p.title} summary={p.summary} />;
};

const diffView: SurfaceView = ({ props }) => {
  const p = DiffViewComponent.props.parse(props) as { diff: string; title?: string };
  const lines = classifyDiff(p.diff);
  const added = lines.filter((l) => l.kind === 'add').length;
  const removed = lines.filter((l) => l.kind === 'del').length;
  return (
    <figure className="sf-diff">
      <figcaption className="sf-diff-title">
        {p.title ? <span className="sf-diff-name">{p.title}</span> : null}
        <span className="sf-diff-count">{`+${added} -${removed}`}</span>
      </figcaption>
      <div className="sf-diff-body" role="region" aria-label={p.title ?? 'Changes'} tabIndex={0}>
        {lines.map((l, i) => (
          <div key={i} className={`sf-diff-line sf-diff-${l.kind}`}>
            {l.text === '' ? ' ' : l.text}
          </div>
        ))}
      </div>
    </figure>
  );
};

/** The drawing for each registered name. A registered name with no drawing here (a newer server) is shown as a card, never skipped silently. */
export const SURFACE_VIEWS: ReadonlyMap<string, SurfaceView> = new Map<string, SurfaceView>([
  ['Stack', stack],
  ['Row', row],
  ['Grid', grid],
  ['Heading', heading],
  ['Text', text],
  ['Stat', stat],
  ['Table', table],
  ['Chart', chart],
  ['List', list],
  ['Badge', badge],
  ['Button', button],
  ['Callout', callout],
  ['Code', code],
  ['Divider', divider],
  ['EntityCard', entityCard],
  ['PersonChip', personChip],
  ['ChannelLink', channelLink],
  ['ApprovalCard', approvalCard],
  ['DiffView', diffView],
]);
