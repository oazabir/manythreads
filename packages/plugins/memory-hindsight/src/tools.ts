import { MemoryError, type MemoryProvider, type PluginContext } from '@manythreads/sdk';
import { RecallArgs, RetainArgs, refuseBankFields } from './schemas.ts';

// The two tools a bot's run has (`memory.recall`, `memory.retain`; SPEC 12.1). Registered as capabilities, so the broker's allowlist decides
// who has them and the MCP gateway describes and calls them like any other. Each handler gets `(input, tx)` and nothing about a bank: the
// bank is `provider.forRun(tx)`, derived from the run the transaction belongs to. A handler never throws for a refusal: the model reads
// the answer (`ok: false`, a code, a sentence) and can try something else.

export type ToolAnswer = { ok: true; [key: string]: unknown } | { ok: false; code: string; message: string };

const refuse = (code: string, message: string): ToolAnswer => ({ ok: false, code, message });

function answerFor(err: unknown): ToolAnswer {
  if (err instanceof MemoryError) return refuse(err.code, err.message);
  return refuse('unavailable', 'Memory failed to answer.');
}

export function registerMemoryTools(ctx: PluginContext, provider: MemoryProvider): void {
  ctx.capabilities.register('memory.recall', async (input, tx): Promise<ToolAnswer> => {
    try {
      refuseBankFields(input);
      const parsed = RecallArgs.safeParse(input);
      if (!parsed.success) return refuse('invalid_arguments', parsed.error.issues.map((i) => `${i.path.map(String).join('.') || '(arguments)'}: ${i.message}`).join('; '));
      const bank = await provider.forRun(tx);
      const result = await bank.recall({ query: parsed.data.query, ...(parsed.data.limit ? { limit: parsed.data.limit } : {}), ...(parsed.data.tags ? { tags: parsed.data.tags } : {}) });
      return { ok: true, bank: result.bank, hits: result.hits };
    } catch (err) {
      return answerFor(err);
    }
  });

  ctx.capabilities.register('memory.retain', async (input, tx): Promise<ToolAnswer> => {
    try {
      refuseBankFields(input);
      const parsed = RetainArgs.safeParse(input);
      if (!parsed.success) return refuse('invalid_arguments', parsed.error.issues.map((i) => `${i.path.map(String).join('.') || '(arguments)'}: ${i.message}`).join('; '));
      const bank = await provider.forRun(tx);
      const result = await bank.retain([
        { content: parsed.data.content, ...(parsed.data.context ? { context: parsed.data.context } : {}), ...(parsed.data.tags ? { tags: parsed.data.tags } : {}) },
      ]);
      return { ok: true, bank: result.bank, retained: result.items };
    } catch (err) {
      return answerFor(err);
    }
  });
}
