// The output style: how every bot writes, whatever its template says. The runtime adds this text after the bot's own instructions on every run (the Hermes
// gateway's `instructions`, and `SOUL.md` for a local profile), so a bot made from any template, or written by hand, produces text the chat draws well.
// It also says how to ask a person for a decision (`approvals.ask`, offered to every bot): one place, every runtime. The templates repeat the same rules in plain words; this is the copy that cannot be forgotten. The server also repairs what a bot still gets wrong
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
  '',
  '## When you need a person to decide',
  '',
  'When you need a person to say yes or no before you go on — a risky command, a choice that is theirs to make, something you were told to confirm — call the tool `approvals.ask` with one clear question and, in `details`, what they need to read to decide. The question appears in this thread and in the team’s Approvals list, and you are woken in this thread with their answer. Then end your turn with one line saying what you are waiting for. Do not wait on a prompt of your own program and do not ask by posting a question and sleeping: nobody is shown such a prompt, so the run only hangs.',
].join('\n');

/**
 * The bot's own instructions followed by the output style. The style is always added, also to an empty body, and never changes the bot's text above it.
 */
export function withOutputStyle(body: string): string {
  const own = body.trim();
  return own === '' ? OUTPUT_STYLE : `${own}\n\n${OUTPUT_STYLE}`;
}
