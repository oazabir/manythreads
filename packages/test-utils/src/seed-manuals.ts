// The `product-manuals` knowledge base of the seed (PLAN P8-12): four short manuals for two invented products, each holding facts that exist nowhere else, so a search or
// a bot's answer can be checked against the one document it must cite. The data has no server in it; `seedProductManuals` puts it in through the knowledge routes
// (a lead makes the base, then uploads each file), exactly as a person would.

export const PRODUCT_MANUALS_SLUG = 'product-manuals';
export const PRODUCT_MANUALS_NAME = 'Product manuals';

export interface ManualDocument {
  /** The upload name; the readable copy in the team's repo is named after it. */
  name: string;
  markdown: string;
}

export interface ManualQuestion {
  question: string;
  /** The upload name of the one document that answers it. */
  document: string;
  /** Words from the passage that answers it (case as written). */
  answerHas: string;
}

export const PRODUCT_MANUALS: readonly ManualDocument[] = [
  {
    name: 'Harbour Hub setup.md',
    markdown: `# Harbour Hub setup

The Harbour Hub is the small white router that comes with every Kahf Home plan.

## First start

Plug the power cable into the back of the hub and wait until the front light turns steady green. This takes about 90 seconds. Then join the network called HarbourHub-Setup from your phone.

## The admin page

Open http://192.168.7.1 in a browser while you are connected to the hub. The first password is printed on the sticker under the hub. You are asked to change it the first time you sign in.

## Factory reset

Hold the reset pinhole for 12 seconds with a paper clip until the light blinks white. All settings, including the password, go back to what they were in the box.
`,
  },
  {
    name: 'Harbour Hub troubleshooting.md',
    markdown: `# Harbour Hub troubleshooting

## Light patterns

A steady green light means the hub works. A slow amber blink means the hub has power but no internet. A fast red blink means the hub is too hot and has slowed itself down.

## Error codes on the admin page

Error E41 means the hub cannot reach the internet provider. Restart the provider's modem first, then the hub.

Error E52 means the hub overheated. Move it away from walls and heaters and wait 10 minutes before turning it on again.

## When nothing helps

Write down the serial number from the sticker and call the support line. Support answers from 8 to 6, Monday to Friday.
`,
  },
  {
    name: 'Lantern lamp care.md',
    markdown: `# Lantern lamp care

The Lantern is the smart desk lamp of the Kahf Home range.

## Bulb life

The built-in light lasts about 25,000 hours, which is more than ten years of normal use. The bulb cannot be replaced; the whole head is swapped under the warranty.

## Cleaning

Switch the lamp off and let it cool. Wipe the shade with a dry or slightly damp soft cloth. Never use window cleaner, because it clouds the shade.

## Pairing with the Hub

Hold the lamp's button for 5 seconds until it pulses blue, then press pair in the Kahf Home app. The Lantern works only with a Harbour Hub on the 2.4 GHz network.
`,
  },
  {
    name: 'Warranty and returns.md',
    markdown: `# Warranty and returns

## Returns

Any Kahf Home product can be returned within 30 days of delivery if it is in its box with all its parts. The refund is paid to the original payment method within 7 days of the product arriving back.

## Warranty

The Harbour Hub has a warranty of 2 years. The Lantern lamp has a warranty of 3 years. Both start on the delivery date and need the proof of purchase.

## What the warranty does not cover

Damage from water, from a power surge, or from opening the hub or lamp is not covered.
`,
  },
];

/** Questions with the one document that answers each: a search for the question must put that document first, and its passage holds `answerHas`. */
export const PRODUCT_MANUALS_QUESTIONS: readonly ManualQuestion[] = [
  { question: 'how do I factory reset the hub', document: 'Harbour Hub setup.md', answerHas: '12 seconds' },
  { question: 'what does error E52 mean', document: 'Harbour Hub troubleshooting.md', answerHas: 'overheated' },
  { question: 'how long does the lantern bulb last', document: 'Lantern lamp care.md', answerHas: '25,000 hours' },
  { question: 'what is the warranty on the lantern lamp', document: 'Warranty and returns.md', answerHas: '3 years' },
  { question: 'how many days do I have to return a product', document: 'Warranty and returns.md', answerHas: '30 days' },
];

export interface SeedProductManualsOptions {
  /** The server's address (`TestServer.url`, or the live site). */
  url: string;
  /** The team that owns the base, by slug (default `engineering`). */
  team?: string;
  /** A lead of the team: the one who makes the base and uploads. */
  lead: { actorId: string; workspaceId: string };
}

export interface SeedProductManualsResult {
  base: string;
  documents: Array<{ name: string; status: string; chunkCount: number }>;
}

/** Makes the base (a repeat is fine) and uploads the four manuals through the knowledge routes. Throws with the server's words if a step is refused. */
export async function seedProductManuals(options: SeedProductManualsOptions): Promise<SeedProductManualsResult> {
  const team = options.team ?? 'engineering';
  const actor = { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: options.lead.actorId, workspaceId: options.lead.workspaceId }) };
  const made = await fetch(`${options.url}/api/teams/${team}/knowledge`, {
    method: 'POST',
    headers: { ...actor, 'content-type': 'application/json' },
    body: JSON.stringify({ slug: PRODUCT_MANUALS_SLUG, name: PRODUCT_MANUALS_NAME }),
  });
  if (made.status !== 201 && made.status !== 409) throw new Error(`could not make the ${PRODUCT_MANUALS_SLUG} base: ${made.status} ${await made.text()}`);
  const documents: SeedProductManualsResult['documents'] = [];
  for (const doc of PRODUCT_MANUALS) {
    const res = await fetch(`${options.url}/api/teams/${team}/knowledge/${PRODUCT_MANUALS_SLUG}/documents?name=${encodeURIComponent(doc.name)}`, {
      method: 'POST',
      headers: { ...actor, 'content-type': 'application/octet-stream' },
      body: Buffer.from(doc.markdown, 'utf8') as unknown as RequestInit['body'],
    });
    const text = await res.text();
    if (res.status !== 200) throw new Error(`could not upload ${doc.name}: ${res.status} ${text}`);
    const d = (JSON.parse(text) as { document: { name: string; status: string; chunkCount: number } }).document;
    documents.push({ name: d.name, status: d.status, chunkCount: d.chunkCount });
  }
  return { base: PRODUCT_MANUALS_SLUG, documents };
}
