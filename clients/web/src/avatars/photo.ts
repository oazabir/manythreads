import { AVATAR_PHOTO_MAX_BYTES, type UploadMyPhotoRequest } from '@manythreads/shared';

/** The side of the square a photo is shrunk to. A face needs no more, and the file stays far below the server's limit. */
export const PHOTO_SIDE = 256;
/** A photo larger than this is refused before it is read at all (a phone photo is a few MB; this is generous). */
const PICKED_MAX_BYTES = 15 * 1024 * 1024;

export class PhotoProblem extends Error {}

/** The largest centred square of an image, as `side` pixels. */
export function squareBox(width: number, height: number): { sx: number; sy: number; size: number } {
  const size = Math.min(width, height);
  return { sx: Math.floor((width - size) / 2), sy: Math.floor((height - size) / 2), size };
}

const toBase64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};

/**
 * Turns a picked file into the request the server takes: decoded by the browser (so a file that is not a picture, or an SVG, never gets through), cut to
 * its centred square, shrunk to 256 pixels and saved as WebP (JPEG where the browser cannot write WebP). Transparency is kept.
 */
export async function preparePhoto(file: File): Promise<UploadMyPhotoRequest> {
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') throw new PhotoProblem('Choose a picture file (PNG, JPEG or WebP).');
  if (file.size > PICKED_MAX_BYTES) throw new PhotoProblem('That picture is too large. Choose one under 15 MB.');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new PhotoProblem('That file could not be read as a picture.');
  }
  try {
    const { sx, sy, size } = squareBox(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = PHOTO_SIDE;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new PhotoProblem('This browser cannot prepare the picture.');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, sx, sy, size, size, 0, 0, PHOTO_SIDE, PHOTO_SIDE);
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/webp', 0.9));
    const out = blob && blob.type === 'image/webp' ? blob : await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/jpeg', 0.9));
    if (!out || (out.type !== 'image/webp' && out.type !== 'image/jpeg')) throw new PhotoProblem('This browser cannot prepare the picture.');
    if (out.size > AVATAR_PHOTO_MAX_BYTES) throw new PhotoProblem('That picture is still too large after shrinking. Choose another.');
    return { contentType: out.type as 'image/webp' | 'image/jpeg', data: await toBase64(out) };
  } finally {
    bitmap.close();
  }
}
