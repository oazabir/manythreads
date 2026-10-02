/** Where a file's bytes come from: the host asks for the form a viewer wants. */
export type ContentSource = {
  /** A URL a media element, an iframe or pdf.js can load (same origin, the session cookie rides along). */
  url: string;
  text(): Promise<string>;
  bytes(): Promise<Uint8Array>;
};

export class ContentError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ContentError';
  }
}

const refuse = (status: number): string =>
  status === 403 ? 'You do not have access to this file.' : status === 404 ? 'This file no longer exists.' : 'The file could not be loaded.';

/** A file behind an HTTP URL on this origin. */
export function httpSource(url: string): ContentSource {
  const get = async (): Promise<Response> => {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new ContentError(res.status, refuse(res.status));
    return res;
  };
  return {
    url,
    text: async () => (await get()).text(),
    bytes: async () => new Uint8Array(await (await get()).arrayBuffer()),
  };
}

/** A file already in memory (tests, previews); `url` is optional for media. */
export function memorySource(content: { text?: string; bytes?: Uint8Array; url?: string }): ContentSource {
  return {
    url: content.url ?? '',
    text: () => Promise.resolve(content.text ?? new TextDecoder().decode(content.bytes ?? new Uint8Array())),
    bytes: () => Promise.resolve(content.bytes ?? new TextEncoder().encode(content.text ?? '')),
  };
}
