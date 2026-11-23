/*
 * Making a capture small before it is uploaded (owner, 2026-11-23). A screenshot goes through browser-image-compression (in this page: the library's worker
 * would load itself from a CDN, which this site's policy does not allow). A screen recording is transcoded by ffmpeg.wasm to H.264 in MP4, at most 1280 pixels
 * wide; the 32 MB core is a file of this site, loaded only the first time someone records. When the recording cannot be made smaller, the original is kept.
 */

/** The longest side of a screenshot, and the size it aims for. */
const IMAGE_MAX_SIDE = 2560;
const IMAGE_TARGET_MB = 1;

/** A screenshot as WebP (text stays sharp at a fraction of PNG's size); the original when that is smaller. */
export async function compressScreenshot(png: Blob, name: string): Promise<File> {
  const original = new File([png], `${name}.png`, { type: 'image/png' });
  try {
    const { default: imageCompression } = await import('browser-image-compression');
    const small = await imageCompression(original, { maxSizeMB: IMAGE_TARGET_MB, maxWidthOrHeight: IMAGE_MAX_SIDE, useWebWorker: false, fileType: 'image/webp', initialQuality: 0.9 });
    return small.size < original.size ? new File([small], `${name}.webp`, { type: 'image/webp' }) : original;
  } catch {
    return original;
  }
}

export type TranscodeProgress = (fraction: number, stage: 'loading' | 'encoding') => void;

let loaded: Promise<import('@ffmpeg/ffmpeg').FFmpeg> | null = null;

/** The one ffmpeg of this page, loaded once from this site's own files. */
async function ffmpeg(onProgress: TranscodeProgress): Promise<import('@ffmpeg/ffmpeg').FFmpeg> {
  if (!loaded) {
    loaded = (async () => {
      onProgress(0, 'loading');
      const [{ FFmpeg }, core, wasm] = await Promise.all([
        import('@ffmpeg/ffmpeg'),
        import('@ffmpeg/core/dist/esm/ffmpeg-core.js?url'),
        import('@ffmpeg/core/dist/esm/ffmpeg-core.wasm?url'),
      ]);
      const ff = new FFmpeg();
      await ff.load({ coreURL: core.default, wasmURL: wasm.default });
      return ff;
    })();
    loaded.catch(() => {
      loaded = null;
    });
  }
  return loaded;
}

/**
 * A screen recording as H.264 MP4 (it plays everywhere and is much smaller than the browser's WebM): at most 1280 wide, 24 frames a second, the sound as AAC.
 * Returns the original WebM when the transcode fails or does not make it smaller.
 */
export async function compressRecording(webm: Blob, name: string, onProgress: TranscodeProgress, hasAudio: boolean): Promise<File> {
  const original = new File([webm], `${name}.webm`, { type: 'video/webm' });
  try {
    const ff = await ffmpeg(onProgress);
    const progress = ({ progress }: { progress: number }): void => onProgress(Math.max(0, Math.min(1, progress)), 'encoding');
    ff.on('progress', progress);
    try {
      onProgress(0, 'encoding');
      await ff.writeFile('in.webm', new Uint8Array(await webm.arrayBuffer()));
      await ff.exec([
        '-i', 'in.webm',
        '-vf', "scale='min(1280,iw)':-2,fps=24",
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
        ...(hasAudio ? ['-c:a', 'aac', '-b:a', '96k'] : ['-an']),
        'out.mp4',
      ]);
      const out = await ff.readFile('out.mp4');
      const bytes = typeof out === 'string' ? new TextEncoder().encode(out) : out;
      await ff.deleteFile('in.webm').catch(() => undefined);
      await ff.deleteFile('out.mp4').catch(() => undefined);
      if (bytes.byteLength === 0 || bytes.byteLength >= webm.size) return original;
      return new File([bytes.slice()], `${name}.mp4`, { type: 'video/mp4' });
    } finally {
      ff.off('progress', progress);
    }
  } catch {
    return original;
  }
}

/** `Screenshot 2026-11-23 19.58` */
export const captureName = (kind: 'Screenshot' | 'Screen recording', at: Date = new Date()): string =>
  `${kind} ${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ${String(at.getHours()).padStart(2, '0')}.${String(at.getMinutes()).padStart(2, '0')}`;
