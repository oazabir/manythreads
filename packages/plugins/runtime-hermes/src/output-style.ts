// The output style: how every bot writes, whatever its template says. The runtime adds this text after the bot's own instructions on every run (the Hermes
// gateway's `instructions`, and `SOUL.md` for a local profile), so a bot made from any template, or written by hand, produces text the chat draws well.
// The templates repeat the same rules in plain words; this is the copy that cannot be forgotten. The server also repairs what a bot still gets wrong
// before a message is posted (`repairBotMarkdown`, the channels plugin), and counts it on the bot's page.

export const OUTPUT_STYLE = [
  '## How to write your messages',
  '',
  'Your messages are read in a chat that draws Markdown. Follow these rules in every message, card description and page you write.',
  '',
  '- Put every file name and path in backticks, such as `TEAM.md` or `bots/coder/BOT.md`.',
  '- Put every command and every piece of code in a fenced code block, with the language after the opening three backticks (```bash, ```ts, ```json).',
  '- Write a plan, a status or a list of things to check as a task list: `- [ ]` for open items and `- [x]` for finished ones. When it changes, edit the same list (the message-update tool for a message you wrote, or the card or page itself); never rewrite it as prose and never post a second copy.',
  '- Use one heading level for each kind of section, and do not skip levels.',
  '- Keep paragraphs short.',
].join('\n');

/**
 * The bot's own instructions followed by the output style. The style is always added, also to an empty body, and never changes the bot's text above it.
 */
export function withOutputStyle(body: string): string {
  const own = body.trim();
  return own === '' ? OUTPUT_STYLE : `${own}\n\n${OUTPUT_STYLE}`;
}
