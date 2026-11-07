import type { ChatModelOption } from '@manythreads/shared';

/** The alias a message will carry: the person's pick, else the conversation's, else the bot's first alias. Never one that is not on the menu or is greyed. */
export function pickedAlias(options: readonly ChatModelOption[], picked: string | null, saved: string | null): string | null {
  for (const alias of [picked, saved]) {
    if (alias !== null && options.some((o) => o.alias === alias)) return alias;
  }
  return defaultOption(options)?.alias ?? null;
}

export const defaultOption = (options: readonly ChatModelOption[]): ChatModelOption | undefined => options.find((o) => o.isDefault) ?? options[0];

export const optionFor = (options: readonly ChatModelOption[], alias: string | null): ChatModelOption | undefined => options.find((o) => o.alias === alias);
