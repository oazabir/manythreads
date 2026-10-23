import { describe, expect, it } from 'vitest';
import { FileSummary } from '@manythreads/shared';
import { isPreviewableImage, splitAttachments } from '../src/channels/images';

const file = (name: string, mime: string): FileSummary =>
  FileSummary.parse({ id: '00000000-0000-4000-8000-000000000001', name, size: 1024, mime });

describe('pictures in a message', () => {
  it('previews the image types the files route serves inline, and nothing else', () => {
    expect(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'].every((m) => isPreviewableImage(file('x', m)))).toBe(true);
    // an SVG is served as opaque bytes (it can run script), so `<img>` cannot draw it: it stays a file card
    expect(isPreviewableImage(file('x.svg', 'image/svg+xml'))).toBe(false);
    expect(isPreviewableImage(file('x.pdf', 'application/pdf'))).toBe(false);
    expect(isPreviewableImage(file('x.bin', 'application/octet-stream'))).toBe(false);
  });

  it('splits a message’s attachments into pictures and cards, keeping their order', () => {
    const png = file('shot.png', 'image/png');
    const pdf = file('plan.pdf', 'application/pdf');
    const jpg = file('photo.jpg', 'image/jpeg');
    const split = splitAttachments([png, pdf, jpg]);
    expect(split.images.map((f) => f.name)).toEqual(['shot.png', 'photo.jpg']);
    expect(split.files.map((f) => f.name)).toEqual(['plan.pdf']);
  });

  it('answers a message with no attachments with two empty lists', () => {
    expect(splitAttachments(undefined)).toEqual({ images: [], files: [] });
    expect(splitAttachments([])).toEqual({ images: [], files: [] });
  });
});
