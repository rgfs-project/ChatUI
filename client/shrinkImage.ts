/**
 * Makes a picture cheap enough to send, before it is sent.
 *
 * An image costs the model tokens by area, not by file size: the budget charges
 * roughly one token per 3,136 pixels, so a 4000x2356 screenshot from a
 * high-density display is about 3,000 tokens and three of them are 9,000 —
 * more than an 8k model has room for once a reply is reserved. The reader's
 * side of that is a message refused for being too large, after the upload has
 * already finished.
 *
 * Nothing above `MAX_EDGE` is worth sending anyway. Vision models tile an image
 * into patches and work at their own resolution; past the size they tile to,
 * the extra pixels are re-sampled away upstream and charged for on the way.
 *
 * ## What is kept
 *
 * The aspect ratio, and the picture a reader would recognise. This is a lossy
 * re-encode of somebody's file, so it is done only where it buys something: an
 * image already inside the cap is passed through untouched, and so is anything
 * that is not a raster image — an SVG has no pixels to lose and a PDF is not
 * ours to re-draw.
 *
 * ## Where it happens
 *
 * In the browser, before the upload. The alternative is to store the original
 * and shrink server-side when assembling the prompt, which keeps the full
 * picture in the transcript — but it needs an image codec on a server that has
 * none, and it would still spend the reader's upload and their disk quota on
 * pixels nothing will ever look at.
 */

/** The long edge a picture is reduced to, in pixels. */
const MAX_EDGE = 1_536;

/** Below this there is nothing to gain, whatever the dimensions say. */
const MIN_BYTES = 256 * 1_024;

/** Quality for the re-encode. High enough that text in a screenshot stays sharp. */
const QUALITY = 0.85;

/** What a shrunk picture is written as, in order of preference. */
const TYPES = ['image/webp', 'image/jpeg'] as const;

function isRaster(file: File): boolean {
  return (
    file.type === 'image/png' ||
    file.type === 'image/jpeg' ||
    file.type === 'image/webp' ||
    file.type === 'image/gif'
  );
}

/** The name the smaller file carries, with the extension its new type wants. */
function renamed(name: string, type: string): string {
  const stem = name.replace(/\.[^.]+$/, '');
  return `${stem}.${type === 'image/webp' ? 'webp' : 'jpg'}`;
}

async function encode(canvas: HTMLCanvasElement): Promise<{ blob: Blob; type: string } | null> {
  for (const type of TYPES) {
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, type, QUALITY);
    });
    // A browser that cannot write this type answers with the one it can, so the
    // blob's own type is what it really is rather than what was asked for.
    if (blob !== null && blob.type === type) return { blob, type };
  }
  return null;
}

/**
 * Returns a smaller file, or the original when there is nothing to gain.
 *
 * Never throws: a picture that cannot be decoded, drawn or encoded here is one
 * the server will judge for itself, which is where the real limits live.
 */
export async function shrinkImage(file: File): Promise<File> {
  if (!isRaster(file) || file.size < MIN_BYTES) return file;
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }

  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    if (longest <= MAX_EDGE) return file;

    const scale = MAX_EDGE / longest;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));

    const context = canvas.getContext('2d');
    if (context === null) return file;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    const encoded = await encode(canvas);
    if (encoded === null) return file;

    // Only if it actually is smaller. A flat screenshot can re-encode larger
    // than the PNG it came from, and then the original is the better file.
    if (encoded.blob.size >= file.size) return file;

    return new File([encoded.blob], renamed(file.name, encoded.type), {
      type: encoded.type,
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  } finally {
    bitmap.close();
  }
}
