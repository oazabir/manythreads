import { runAcp } from '../acp/session.ts';
import type { Driver } from './types.ts';

// The `acp` driver (P25-03): any agent with an ACP adapter (Claude, Codex, Hermes, OpenCode), one adapter process per run. The work is in `../acp/`.
export const acpDriver: Driver = { run: runAcp };
