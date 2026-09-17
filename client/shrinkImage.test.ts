import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MAX_EDGE, shrinkImage } from './shrinkImage.ts';

/**
 * The guard in front of the re-encode.
 *
 * `0` is the reader asking for their picture to be sent as they took it, and it
 * has to be honoured before anything reads the bitmap: a file that is decoded
 * and re-encoded at its own size is still a lossy round trip through the
 * canvas, so "no shrinking" cannot mean "shrink it to itself".
 */
describe('shrinkImage', () => {
  /** A raster file large enough to be past the `MIN_BYTES` floor. */
  function bigPng(): File {
    return new File([new Uint8Array(400 * 1024)], 'shot.png', { type: 'image/png' });
  }

  it('returns the file untouched, and decodes nothing, at an edge of zero', async () => {
    const decode = vi.fn();
    vi.stubGlobal('createImageBitmap', decode);

    const file = bigPng();
    const result = await shrinkImage(file, 0);

    expect(result).toBe(file);
    expect(decode).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('leaves a file that is not a raster image alone whatever the edge', async () => {
    const svg = new File([new Uint8Array(400 * 1024)], 'diagram.svg', { type: 'image/svg+xml' });

    expect(await shrinkImage(svg, 512)).toBe(svg);
  });

  it('has a default edge, so a caller that says nothing still shrinks', () => {
    expect(DEFAULT_MAX_EDGE).toBeGreaterThan(0);
  });
});
