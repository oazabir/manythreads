import type { BotRunHandle, PluginTx } from './types.ts';

// The tool source seam (PLAN P8-01, P8-28): a place other than the platform's own capability handlers that tools for a bot come from. The first is a
// connection to an outside service (the `connections` plugin); the gateway asks each source which of its tools a bot may be offered, and hands a call to the
// source that owns the tool, AFTER the capability broker has authorised it. A source decides nothing the broker decides (is the tool granted, is it
// destructive, does it wait for a person) and the broker decides nothing a source knows (which connection, is it switched on, has its credential expired).
// Both must agree for a tool to be offered or run.
//
// A source's tools are capabilities like any other: each name is declared in the registering plugin's manifest `capabilities` (so the broker knows the name and
// its destructive tag, and `capabilities.native` lists cannot silently reach it), and `tool.source` is in its `extends`. The kernel refuses a source whose tool
// is not declared, that names a tool another source or a capability handler already owns, or that registers a second source with the same id.

/** One line of "what this run read" (`run_source_log`): what kind of thing, which one, and how widely it was visible. */
export interface RunSourceLine {
  sourceType: string;
  sourceRef: string;
  scope: 'team' | 'channel' | 'person';
}

/** How a tool of a source is described to a model, and how a call to it behaves. */
export interface ToolSourceTool {
  /** `namespace.verb`, declared in the registering plugin's manifest. */
  name: string;
  /** What the tool does, written for a model. */
  description: string;
  /** JSON Schema of the arguments, sent to the model as `inputSchema`. */
  inputSchema: Record<string, unknown>;
  /**
   * `read` runs in the transaction of the person who asked (their visibility decides what it can reach) and its hits are logged as what the run read; `write`
   * runs as the bot, is held back in a rehearsal, and may wait for a person's approval. A tool that is neither is not expressible: a tool is one or the other.
   */
  kind: 'read' | 'write';
  /** What a read's answer proves the run read; only for `kind: 'read'`. */
  sourcesFrom?: (result: unknown) => RunSourceLine[];
}

/**
 * How an approval card reads for a call the SOURCE (not the grant) holds for a person: the line the inbox shows and the arguments an approver is shown. The source builds it from
 * rows the platform owns (a recipient it read itself), never from words the model wrote, so a person approving sees where the call really goes.
 */
export interface ToolApprovalCard {
  /** One line for the Approvals inbox (at most 300 characters; the platform clips it). */
  summary: string;
  /** What the approver is shown of the call. Plain values; the platform clips long text and hides secrets. */
  preview: Record<string, unknown>;
}

/** A source of tools. Registered by a plugin that extends `tool.source` (`ctx.toolSources.register`). */
export interface ToolSource {
  /** Unique among the sources (`connections`). */
  readonly id: string;
  /** Every tool the source can ever offer, by name. Fixed when the source is registered. */
  readonly tools: readonly ToolSourceTool[];
  /**
   * Of `tools`, the names `run`'s bot may be offered right now (a grant for it, from a connection that is switched on and has not expired), at grant level: a
   * listing has no arguments. `tx` is a transaction as the bot, so what the bot may not see is not offered. A source that cannot tell answers an empty list;
   * a source that throws offers nothing (the gateway fails closed). The broker's own grant check is asked as well; a tool needs both.
   */
  offered(tx: PluginTx, run: BotRunHandle): Promise<readonly string[]>;
  /**
   * Runs `tool` for `run`. `tx` is the transaction the gateway chose for the tool's kind (the asker's for a read, the bot's for a write), with the run's id
   * set. The broker has already authorised the call, but the source checks its own side again: the grant row, the connection's state, the asker's right to
   * see it. A refusal is a thrown `HttpError` (`forbidden`, `not_found`, `validation_failed`) the gateway turns into a tool answer; anything else the source
   * throws is logged and answered as a plain "the call failed". `run` is read from the database, never from the request.
   */
  call(tx: PluginTx, run: BotRunHandle, tool: string, input: Record<string, unknown>): Promise<unknown>;
  /**
   * Optional. Whether this call must wait for a person whatever the grant says (a send that goes to a stranger, say), and how its card reads; null means the grant decides.
   * Asked by the gateway for a tool that acts (a write), in a transaction as the bot, before the call is run. A call a person has already approved is not asked again (the
   * approvals job runs it directly). It must not change anything. A source that throws is treated as "must wait": the gateway fails closed.
   */
  approval?(tx: PluginTx, run: BotRunHandle, tool: string, input: Record<string, unknown>): Promise<ToolApprovalCard | null>;
}

/**
 * What a plugin that looks at the sources (the gateway) gets: the source without `call`. The one door to a source's credentials is the run service
 * (`ctx.runs.invoke`), which reads the run from its own row first; a plugin holding `call` could skip that, so the kernel never hands it out.
 */
export type ToolSourceView = Pick<ToolSource, 'id' | 'tools' | 'offered' | 'approval'>;

/** `ctx.toolSources`: register a source (needs `tool.source`), and find sources (needs `tool.invoke`, the gateway's door). */
export interface PluginToolSources {
  /** Registers a source. Throws when a tool is not declared in the manifest, is owned by something else already, or the id is taken. */
  register(source: ToolSource): void;
  /** Every registered source, in registration order. Only for a plugin that extends `tool.invoke`. */
  list(): readonly ToolSourceView[];
  /** The source that owns the tool, with the tool's description; undefined when none does. Only for a plugin that extends `tool.invoke`. */
  find(toolName: string): { source: ToolSourceView; tool: ToolSourceTool } | undefined;
}
