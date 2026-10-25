import { z } from 'zod';
import { HermesConnectionAgent } from '../../entities/hermes.ts';

// What the server adds to the body of `POST <gateway>/p/<profile>/v1/runs` when the connection's agent is a bridge (`claude-code` or `codex`).
// The agent bridge (tools/agent-bridge) answers the same run API as a Hermes gateway but has no profile of its own: it starts one command-line
// agent per run, so everything that agent needs for that one run travels in the request, under the key `manythreads`. A `hermes` agent never
// receives this object, because it holds its own bot credential and the run token must not reach it.

export const AGENT_BRIDGE_RUN_KEY = 'manythreads';

/** The agents that take the extension: every agent but Hermes itself. */
export const AgentBridgeAgent = HermesConnectionAgent.exclude(['hermes']);
export type AgentBridgeAgent = z.infer<typeof AgentBridgeAgent>;

export const AgentBridgeRunExtension = z.strictObject({
  /** The bot's slug. */
  bot: z.string().min(1).max(80),
  runId: z.string().min(1).max(100),
  /** The platform's one MCP address and a token that opens only this run, valid for at least the run's budget. Sent as `Authorization: Bearer`. */
  mcp: z.strictObject({ url: z.string().url(), token: z.string().min(1).max(200) }),
  /** The runtime tool names the definition allows (`capabilities.runtime`). */
  tools: z.array(z.string().min(1).max(100)).max(200),
  /** The model alias and effort the definition names, when it names them. */
  model: z.strictObject({ alias: z.string().min(1).max(100).optional(), effort: z.enum(['low', 'medium', 'high']).optional() }).optional(),
  /** The run's wall-clock budget in seconds; null when the definition sets none. */
  budgetSeconds: z.number().int().positive().nullable(),
  /** The most turns the agent may take; null for no limit. */
  maxTurns: z.number().int().positive().nullable(),
});
export type AgentBridgeRunExtension = z.infer<typeof AgentBridgeRunExtension>;
