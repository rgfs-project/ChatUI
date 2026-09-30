/**
 * Build step: precompresses every hashed client asset with Brotli (quality
 * 11) and gzip (level 9) next to the original (`x.js.br`, `x.js.gz`). The
 * server serves the best variant the browser accepts; nothing is compressed
 * per request. Deterministic: the same input bytes give the same outputs.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const ROOT = path.resolve(import.meta.dirname, "..");
const ASSETS = path.join(ROOT, "build", "client", "assets");
const COMPRESSIBLE = /\.(js|css|svg|json|txt|map)$/;
/** Below this, compression overhead is not worth it. */
const MIN_BYTES = 1024;

let files = 0;
let raw = 0;
let br = 0;
for (const name of readdirSync(ASSETS)) {
  if (!COMPRESSIBLE.test(name)) continue;
  const file = path.join(ASSETS, name);
  if (statSync(file).size < MIN_BYTES) continue;
  const bytes = readFileSync(file);
  const brotli = brotliCompressSync(bytes, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
    },
  });
  writeFileSync(`${file}.br`, brotli);
  writeFileSync(`${file}.gz`, gzipSync(bytes, { level: 9 }));
  files++;
  raw += bytes.length;
  br += brotli.length;
}
process.stdout.write(
  `compress-assets: ${String(files)} files, ${String(Math.round(raw / 1024))} KiB → ${String(Math.round(br / 1024))} KiB brotli\n`,
);
