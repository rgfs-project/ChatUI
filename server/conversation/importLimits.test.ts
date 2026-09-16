import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { IMPORT_MAX_ENTRIES, IMPORT_MAX_TOTAL_BYTES, readExport } from './importExport.ts';

/**
 * What an upload limit is actually limiting.
 *
 * The upload route bounds the bytes that arrive. An archive's bytes are the
 * *compressed* ones, and the ratio between those and what they expand to is
 * chosen by whoever made the archive — a few kilobytes of zeros is megabytes
 * once inflated, and there is no upper bound on the trick. Expanding the whole
 * archive into memory before looking at any of it meant the real limit on this
 * request was whatever the sender felt like making it, on a server every other
 * account shares.
 *
 * So the archive is read under limits of its own, and — since only `.json`
 * members are ever used — the rest is never inflated at all.
 */

/** Highly compressible filler: the cheap half of a zip bomb. */
function filler(size: number): Uint8Array {
  return new Uint8Array(Buffer.alloc(size, 0x61));
}

/**
 * Rewrites every size a zip declares about itself.
 *
 * A zip states each member's uncompressed length twice — in the local file
 * header and again in the central directory — and both are just numbers the
 * writer chose. Nothing verifies them against the compressed stream, so an
 * archive can claim to hold ten bytes and hold forty megabytes. This is how an
 * archive that lies is built, and the point of building one is that a reader
 * which consults those numbers to decide what is safe to expand is consulting
 * the sender.
 */
function declareSize(zip: Uint8Array, claimed: number): Uint8Array {
  const copy = new Uint8Array(zip);
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);

  for (let at = 0; at + 4 <= copy.length; at += 1) {
    if (copy[at] !== 0x50 || copy[at + 1] !== 0x4b) continue;
    // Local file header: uncompressed size at +22. Central directory: at +24.
    if (copy[at + 2] === 0x03 && copy[at + 3] === 0x04) view.setUint32(at + 22, claimed, true);
    if (copy[at + 2] === 0x01 && copy[at + 3] === 0x02) view.setUint32(at + 24, claimed, true);
  }
  return copy;
}

function conversationJson(): Uint8Array {
  return new Uint8Array(
    Buffer.from(
      JSON.stringify([
        {
          uuid: '11111111-1111-4111-8111-111111111111',
          name: 'Kept',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          chat_messages: [
            {
              uuid: '22222222-2222-4222-8222-222222222222',
              sender: 'human',
              text: 'hello',
              created_at: '2026-01-01T00:00:00Z',
            },
          ],
        },
      ]),
      'utf8'
    )
  );
}

describe('an archive that expands far beyond its upload size', () => {
  /*
   * Driven at small limits rather than the shipped ones, so the property is
   * asserted exactly instead of by allocating a quarter of a gigabyte. The
   * defaults are checked separately below.
   */
  const SMALL = { maxTotalBytes: 4_096, maxEntries: 3 };

  it('refuses one that expands past the total limit', () => {
    const archive = zipSync({ 'big.json': filler(SMALL.maxTotalBytes * 16) });

    // A fraction of its expanded size on the wire, which is what makes the
    // upload limit no limit at all here.
    expect(archive.length).toBeLessThan(SMALL.maxTotalBytes);
    expect(() => readExport(archive, SMALL)).toThrow(/too large/i);
  });

  /**
   * The one that matters, and the one a declared-size check cannot pass.
   *
   * Same bomb, with its headers rewritten to claim it holds ten bytes. A reader
   * that asks the archive how big it is admits this and expands all of it; a
   * reader that counts what comes out stops in the same place it stopped for
   * the honest one.
   */
  it('refuses one whose headers claim it is small', () => {
    const honest = zipSync({ 'big.json': filler(SMALL.maxTotalBytes * 16) });
    const lying = declareSize(honest, 10);

    expect(() => readExport(lying, SMALL)).toThrow(/too large/i);
  });

  /**
   * And the bound is on what is allocated, not merely on what is reported: the
   * refusal happens while the member is still arriving, so the memory in hand
   * never reaches the full expansion. Deflate cannot exceed 1032:1, so the most
   * that can appear between two checks is one slice's worth of that.
   */
  it('stops while the member is still arriving, not after', () => {
    const huge = zipSync({ 'big.json': filler(64 * 1024 * 1024) });

    const before = process.memoryUsage().heapUsed;
    expect(() => readExport(huge, SMALL)).toThrow(/too large/i);
    const growth = process.memoryUsage().heapUsed - before;

    // Nowhere near the 64 MiB the archive expands to.
    expect(growth).toBeLessThan(32 * 1024 * 1024);
  });

  it('refuses one with more members than it will look at', () => {
    const members: Record<string, Uint8Array> = {};
    for (let i = 0; i <= SMALL.maxEntries; i += 1) members[`c${i}.json`] = conversationJson();

    expect(() => readExport(zipSync(members), SMALL)).toThrow(/too many/i);
  });

  it('never inflates a member it has no use for', () => {
    // On its own the .bin is far past the total. It is not JSON, so it is
    // never decompressed, never counted, and the import succeeds.
    const archive = zipSync({
      'conversations.json': conversationJson(),
      'payload.bin': filler(SMALL.maxTotalBytes * 8),
    });

    const found = readExport(archive, SMALL);
    expect(found.conversations).toHaveLength(1);
  });

  it('counts members against a limit the shipped defaults also apply', () => {
    expect(IMPORT_MAX_ENTRIES).toBeGreaterThan(0);
    expect(IMPORT_MAX_TOTAL_BYTES).toBeGreaterThan(0);

    const members: Record<string, Uint8Array> = {};
    for (let i = 0; i < 4; i += 1) members[`c${i}.json`] = conversationJson();

    // Well inside the defaults: a real export must still import untouched.
    expect(readExport(zipSync(members)).conversations).toHaveLength(4);
  });
});

describe('ordinary archives are unaffected', () => {
  it('reads a normal export', () => {
    const found = readExport(zipSync({ 'conversations.json': conversationJson() }));
    expect(found.conversations).toHaveLength(1);
    expect(found.conversations[0]?.name).toBe('Kept');
  });

  it('still reads bare JSON that is not an archive', () => {
    const found = readExport(conversationJson());
    expect(found.conversations).toHaveLength(1);
  });
});
