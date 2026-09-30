/**
 * Sanitizes a real export into a committable fixture (Phase 13e): the
 * structure, field names, nesting, types, counts, identifiers' linkage and
 * edge cases stay; every piece of personal content is replaced.
 *
 *   node scripts/sanitize-export.ts claude <export.zip>... --out <dir>
 *   node scripts/sanitize-export.ts duckai <chat.txt> --out <dir>
 *
 * Kept: structural enums (block `type`, `sender`, tool names, file types,
 * languages, MIME types), numbers, booleans, nulls, the duck.ai boilerplate
 * and heading lines. Replaced consistently: UUIDs (fresh ones, links kept),
 * timestamps (shifted by a fixed number of days, format kept), file names in
 * paths. Replaced with filler of similar shape: everything else (titles,
 * messages, thinking, summaries, file contents, memories, account data).
 * The run fails if any original text of 6 or more characters survives.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import yauzl from "yauzl";
import yazl from "yazl";

const SHIFT_DAYS = 100;
const PRESERVE_KEYS = new Set([
  "type",
  "sender",
  "file_type",
  "mime_type",
  "language",
  "integration_name",
  "tool_origin",
  "icon_name",
  "output_format_category",
  "error_type",
  "media_type",
  "stop_reason",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const ROOT = "00000000-0000-4000-8000-000000000000";
const FILLER =
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua".split(
    " ",
  );

const uuids = new Map<string, string>();
const names = new Map<string, string>();
/** Every original content string, for the leak check. */
const originals = new Set<string>();
/** Structure that is kept on purpose (keys, enums, tool names): never a leak. */
const structural = new Set<string>();

function uuidFor(value: string): string {
  if (value === ROOT) return value;
  let mapped = uuids.get(value);
  if (!mapped) {
    mapped = randomUUID();
    uuids.set(value, mapped);
  }
  return mapped;
}

function shiftTimestamp(value: string): string {
  const match = TIMESTAMP.exec(value);
  if (!match) return value;
  const [, date = "", time = "", fraction = "", zone = ""] = match;
  const shifted = new Date(Date.parse(`${date}T${time}Z`) - SHIFT_DAYS * 86_400_000);
  return `${shifted.toISOString().slice(0, 19)}${fraction}${zone}`;
}

/** Filler with the same number of lines and roughly the same line lengths. */
function filler(text: string, keepMarkdown = true): string {
  let n = 0;
  return text
    .split("\n")
    .map((line) => {
      if (line.trim() === "") return line;
      const prefix = keepMarkdown
        ? (/^\s*(?:#{1,6}\s|[-*>]\s|\d+\.\s|\|)?/.exec(line)?.[0] ?? "")
        : "";
      const words: string[] = [];
      let length = prefix.length;
      while (length < Math.max(prefix.length + 3, line.length)) {
        const word = FILLER[n++ % FILLER.length] ?? "x";
        words.push(word);
        length += word.length + 1;
      }
      return `${prefix}${words.join(" ")}`;
    })
    .join("\n");
}

/** A path keeps its directories and extension; the file name is replaced consistently. */
function sanitizePath(value: string): string {
  const dir = path.posix.dirname(value);
  const ext = path.posix.extname(value);
  const base = path.posix.basename(value, ext);
  let mapped = names.get(base);
  if (!mapped) {
    mapped = `file-${String(names.size + 1)}`;
    names.set(base, mapped);
  }
  originals.add(base);
  return `${dir === "." ? "" : `${dir}/`}${mapped}${ext}`;
}

function remember(value: string): void {
  for (const line of value.split("\n")) if (line.trim().length >= 6) originals.add(line.trim());
}

function sanitize(value: unknown, key: string, parent: Record<string, unknown> | null): unknown {
  if (Array.isArray(value)) {
    // Enum-like string lists (e.g. `modules`) are structure.
    if (key === "modules") return value;
    return value.map((v) => sanitize(v, key, parent));
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    for (const k of Object.keys(object)) structural.add(k);
    return Object.fromEntries(Object.entries(object).map(([k, v]) => [k, sanitize(v, k, object)]));
  }
  if (typeof value !== "string") return value;
  if (UUID.test(value)) return uuidFor(value);
  if (TIMESTAMP.test(value)) return shiftTimestamp(value);
  if (PRESERVE_KEYS.has(key)) {
    structural.add(value);
    return value;
  }
  const siblingType = typeof parent?.type === "string" ? parent.type : "";
  if (key === "name" && (siblingType === "tool_use" || siblingType === "tool_result")) {
    for (const part of value.split(":")) structural.add(part);
    structural.add(value);
    return value;
  }
  if (value.startsWith("/") && !value.includes("\n")) return sanitizePath(value);
  if (key === "name" && siblingType === "local_resource") {
    sanitizePath(`/${value}`);
    return names.get(value) ?? "file";
  }
  if (value === "") return value;
  remember(value);
  if (key.includes("email")) return "person@example.com";
  if (key.includes("ip")) return "192.0.2.1";
  return filler(value);
}

function readZip(file: string): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error) {
        reject(error);
        return;
      }
      const out = new Map<string, Buffer>();
      zip.on("entry", (entry: yauzl.Entry) => {
        zip.openReadStream(entry, (e, stream) => {
          if (e) {
            reject(e);
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c));
          stream.on("end", () => {
            out.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => {
        resolve(out);
      });
      zip.readEntry();
    });
  });
}

async function writeZip(file: string, entries: Map<string, Buffer>): Promise<void> {
  const zip = new yazl.ZipFile();
  for (const [name, data] of entries)
    zip.addBuffer(data, name, { mtime: new Date("1980-01-01T00:00:00Z") });
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk as Buffer);
  writeFileSync(file, Buffer.concat(chunks));
}

function sanitizeDuckAi(text: string): string {
  const bom = text.startsWith("\ufeff") ? "\ufeff" : "";
  const lines = text.replace(/^\ufeff/, "").split("\n");
  return (
    bom +
    lines
      .map((line, index) => {
        if (index === 0 && line.startsWith("This conversation was generated with Duck.ai"))
          return line;
        if (/^(=+|-+)\s*$/.test(line) || line.trim() === "") return line;
        const prompt = /^(User prompt \d+ of \d+ - )(\d{4}-\d{2}-\d{2})(, .*:)\s*$/.exec(line);
        if (prompt) {
          const shifted = new Date(
            Date.parse(`${prompt[2] ?? ""}T00:00:00Z`) - SHIFT_DAYS * 86_400_000,
          );
          return `${prompt[1] ?? ""}${shifted.toISOString().slice(0, 10)}${prompt[3] ?? ""}`;
        }
        // Model heading lines ("Claude Haiku 4.5:") are structure.
        if (/^[A-Z][\w .'-]{1,60}\d[\w .'-]*:$/.test(line)) return line;
        if (/^\|[-:| ]+\|\s*$/.test(line)) return line; // a table separator: structure
        remember(line);
        if (line.startsWith("|"))
          return line.replace(/[^|]+/g, (cell) =>
            cell.trim() ? ` ${filler(cell.trim(), false)} ` : cell,
          );
        return filler(line);
      })
      .join("\n")
  );
}

function leakCheck(outputs: Buffer[]): void {
  const haystack = outputs.map((b) => b.toString("utf8")).join("\n");
  // A string equal to kept structure (a key or enum) is not content.
  const leaks = [...originals].filter((s) => !structural.has(s) && haystack.includes(s));
  if (leaks.length > 0) {
    // Where they survived, without echoing them (SANITIZE_DEBUG=1 prints shapes).
    if (process.env.SANITIZE_DEBUG)
      for (const leak of leaks) {
        const at = haystack.indexOf(leak);
        const context = haystack.slice(Math.max(0, at - 40), at).replace(/[A-Za-z0-9]/g, "x");
        process.stderr.write(
          `  length ${String(leak.length)}, from a path: ${String([...names.keys()].includes(leak))}, after: ${JSON.stringify(context)}\n`,
        );
      }
    process.stderr.write(
      `sanitize: ${String(leaks.length)} original strings survived; not writing\n`,
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const [mode, ...rest] = process.argv.slice(2);
  const outIndex = rest.indexOf("--out");
  const out = outIndex >= 0 ? rest[outIndex + 1] : undefined;
  const inputs = rest.filter((_, i) => i !== outIndex && i !== outIndex + 1);
  if ((mode !== "claude" && mode !== "duckai") || !out || inputs.length === 0) {
    process.stderr.write("usage: sanitize-export.ts claude|duckai <inputs...> --out <dir>\n");
    process.exit(2);
  }
  mkdirSync(out, { recursive: true });
  const results: [string, Buffer][] = [];
  if (mode === "claude") {
    const zips: [string, Map<string, Buffer>][] = [];
    for (const input of inputs) {
      const entries = await readZip(input);
      const sanitized = new Map<string, Buffer>();
      for (const [name, data] of entries) {
        const json: unknown = JSON.parse(data.toString("utf8"));
        // Entry names carry the account UUID: map them like the content.
        const renamed = name.replace(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
          uuidFor,
        );
        sanitized.set(
          renamed,
          Buffer.from(`${JSON.stringify(sanitize(json, "", null), null, 2)}\n`),
        );
      }
      // The export's own naming: "<uuid-prefix>-conversations-000.zip" → "conversations-000.zip".
      zips.push([path.basename(input).replace(/^[0-9a-f]{8}-/, ""), sanitized]);
    }
    leakCheck(zips.flatMap(([, m]) => [...m.values()]));
    for (const [name, entries] of zips) {
      await writeZip(path.join(out, name), entries);
      results.push([name, Buffer.alloc(0)]);
    }
  } else {
    for (const input of inputs) {
      const sanitized = Buffer.from(sanitizeDuckAi(readFileSync(input, "utf8")));
      leakCheck([sanitized]);
      const name = path.basename(input).replace(/^[0-9a-f]{8}-/, "");
      writeFileSync(path.join(out, name), sanitized);
      results.push([name, sanitized]);
    }
  }
  process.stdout.write(`sanitized ${results.map(([n]) => n).join(", ")} into ${out}\n`);
}

await main();
