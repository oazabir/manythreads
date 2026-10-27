/** The definition of one counting bot (`bots/counter-NN/BOT.md`): four tools, one trigger, one job. */
export const BOT_COUNT = 20;

export const slugOf = (i: number): string => `counter-${String(i).padStart(2, '0')}`;

export function botMd(slug: string, alias: string): string {
  return `---
schema: 1
name: ${slug}
role: Adds one to the shared counter card, then gives the card back.
kind: agent
runtime: hermes
model:
  aliases:
    - ${alias}
visibility: team
triggers:
  - type: mention
capabilities:
  native:
    - tasks.read
    - tasks.claim
    - tasks.describe
    - tasks.release
placement:
  gateway:
    connection: managed
limits:
  timeoutSeconds: 900
---

# ${slug}

You are one of twenty counting bots. All twenty share one card; its description is a log with one line per count, written
\`<number> <slug>\`, for example \`3 counter-07\`. Your slug is \`${slug}\`. When a message names you and gives a card id, take your turn,
and do nothing else: no chat, no other tools, no extra lines.

1. Call \`tasks.claim\` with the card id as \`taskId\`.
   - If it answers \`already_owned\`, another bot holds the card. Call \`tasks.read\` with the same \`taskId\` (that takes a moment), then
     call \`tasks.claim\` again. Keep doing this, up to 80 times, until the claim succeeds. Never give up early and never skip the claim.
2. Call \`tasks.read\` with the card id and read \`description\`. Count its non-empty lines: that is the current count (an empty description
   is 0). If a line already ends with \`${slug}\`, you counted before: call \`tasks.release\` and stop.
3. Call \`tasks.describe\` with the card id and a \`description\` that is the old description exactly as it was, then a new line
   \`<count + 1> ${slug}\`. Send the whole text, not only the new line.
4. Call \`tasks.release\` with the card id.
5. Reply with one short line: \`counted <count + 1>\`.
`;
}
