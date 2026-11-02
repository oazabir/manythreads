import type { BotRunHandle, McpToolsProvider } from '@manythreads/sdk';
import { NOT_REALLY_DONE, type WorkshopStepOutcome } from '@manythreads/shared';
import type { ToolSpec } from './wtools.ts';

// The Workshop's Rehearse mode (PLAN P7-05): the bot's own instructions, knowledge and read tools in a sandbox. The promise "nothing leaves the sandbox" is NOT kept here and is not kept by telling
// the model: every call goes through the broker's sandbox (`McpToolsProvider.sandboxCall`, gateway-mcp), which holds back every tool that is not a read, the reply tool included, and writes a line
// for each. All this file does is (1) give the model only the tools the broker offered, under names a model provider accepts, (2) pass each call to the broker and nothing else, and (3) describe
// the result for the person: a held call gets the badge. A name the broker did not offer never reaches it, and the broker refuses anything it does not know on its own.

const MAX_TOOL_ANSWER_CHARS = 20_000;

/**
 * The names a model provider accepts for a tool are letters, digits, underscore and hyphen (`memory.recall` has a dot). The model is offered the wire name; this table answers which tool a wire
 * name stands for. Two names that collapse to one wire name get a number, so the table never loses a tool. (The same rule as the `model` runtime's, which a plugin cannot import.)
 */
export function wireNames(tools: ReadonlyArray<ToolSpec>): { offered: ToolSpec[]; real: Map<string, string> } {
  const real = new Map<string, string>();
  const offered: ToolSpec[] = [];
  for (const tool of tools) {
    const base = tool.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'tool';
    let wire = base;
    for (let n = 2; real.has(wire); n += 1) wire = `${base}_${String(n)}`;
    real.set(wire, tool.name);
    offered.push({ ...tool, name: wire });
  }
  return { offered, real };
}

/** The one place a call named: a path, a channel, a card or a team, as a short string; null when it names none. Never the text that would have been written. */
function targetOf(args: Record<string, unknown>): string | null {
  for (const key of ['path', 'channelId', 'taskId', 'messageId', 'toBotSlug', 'team'] as const) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 120);
  }
  return null;
}

const cleanName = (name: string): string => [...name].filter((ch) => ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f).join('').slice(0, 80);

export interface RehearsalTools {
  /** What the model is offered. */
  specs: ToolSpec[];
  /** One call by wire name. `content` is what the model reads; `step` is what the person sees. */
  call(wire: string, rawArguments: string): Promise<{ content: string; step: { tool: string; what: string; outcome: WorkshopStepOutcome; badge: string | null } }>;
}

export function rehearsalTools(mcp: McpToolsProvider, run: BotRunHandle, sandboxOffered: ToolSpec[]): RehearsalTools {
  const { offered, real } = wireNames(sandboxOffered);
  return {
    specs: offered,
    call: async (wire, rawArguments) => {
      const shown = cleanName(real.get(wire) ?? wire);
      const answer = (code: string, message: string): string => JSON.stringify({ ok: false, code, message });
      const name = real.get(wire);
      if (name === undefined) {
        return { content: answer('unknown_tool', 'There is no such tool.'), step: { tool: shown, what: `Asked for “${shown}”, which this bot does not have`, outcome: 'refused', badge: null } };
      }
      let args: Record<string, unknown> = {};
      if (rawArguments.trim() !== '') {
        try {
          const parsed: unknown = JSON.parse(rawArguments);
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
          args = parsed as Record<string, unknown>;
        } catch {
          return { content: answer('bad_arguments', 'The arguments of the call were not a JSON object.'), step: { tool: shown, what: `Called ${shown} with arguments that could not be read`, outcome: 'refused', badge: null } };
        }
      }
      const result = await mcp.sandboxCall(run, name, args);
      const content = result.text.slice(0, MAX_TOOL_ANSWER_CHARS);
      if (result.held) {
        const target = targetOf(args);
        return {
          content,
          step: { tool: shown, what: `Would have called ${shown}${target === null ? '' : ` on ${target}`}`, outcome: 'held', badge: NOT_REALLY_DONE },
        };
      }
      if (result.isError) return { content, step: { tool: shown, what: `Tried ${shown}; it was refused`, outcome: 'refused', badge: null } };
      const query = typeof args['query'] === 'string' ? ` for “${args['query'].slice(0, 60)}”` : '';
      return { content, step: { tool: shown, what: `Read with ${shown}${query}`, outcome: 'read', badge: null } };
    },
  };
}
