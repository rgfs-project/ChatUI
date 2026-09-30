// Deterministic source capture convention (Phase 13c, contracts §12).
// Pure: no I/O, no clock. Loadable natively (relative imports only).
import { normalizeBody } from "../storage/markdown.ts";

/**
 * The capture rule. A fenced code block becomes an artifact only when all of
 * these hold (anything else is ordinary Markdown code):
 *
 * - It is top level: the opening fence starts the line after at most three
 *   spaces (so fences inside block quotes or indented list content never
 *   count), uses at least three backticks or tildes, and is closed by a
 *   fence of the same character that is at least as long. An unclosed fence
 *   is never captured.
 * - Its info string carries `file=<name>` or `file="<name with spaces>"`,
 *   for example ```` ```python file=hello.py ````. The first token, when it
 *   is not a `key=value` pair, is the language (display only).
 * - The name is a plain file name: 1–128 characters after trimming, no path
 *   separators, no control characters, not `.`/`..`, no leading dot, no
 *   trailing dot or space, and an allowlisted extension (or an allowlisted
 *   exact name such as `Dockerfile`). Anything that looks like a path is
 *   rejected, never normalized.
 * - The body is non-empty and at most `maxBytes` UTF-8 bytes.
 * - At most `maxPerReply` blocks per reply are captured, in document order;
 *   `captureIndex` is the block's position among the eligible blocks.
 *
 * Names are display-only: the stored file is named by a server-minted id.
 */

/** Extension → display media type. The source is always served as text/plain. */
export const ARTIFACT_EXTENSIONS: Readonly<Record<string, string>> = {
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  jsonl: "application/jsonl",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  xml: "application/xml",
  ini: "text/plain",
  cfg: "text/plain",
  conf: "text/plain",
  env: "text/plain",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  scss: "text/x-scss",
  svg: "image/svg+xml",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  jsx: "text/javascript",
  ts: "text/typescript",
  tsx: "text/typescript",
  py: "text/x-python",
  rb: "text/x-ruby",
  php: "text/x-php",
  go: "text/x-go",
  rs: "text/x-rust",
  java: "text/x-java",
  kt: "text/x-kotlin",
  swift: "text/x-swift",
  c: "text/x-c",
  h: "text/x-c",
  cpp: "text/x-c++",
  hpp: "text/x-c++",
  cc: "text/x-c++",
  cs: "text/x-csharp",
  lua: "text/x-lua",
  r: "text/x-r",
  sql: "application/sql",
  sh: "application/x-sh",
  bash: "application/x-sh",
  zsh: "application/x-sh",
  ps1: "text/plain",
  bat: "text/plain",
  tex: "application/x-tex",
  graphql: "application/graphql",
  proto: "text/plain",
  diff: "text/x-diff",
  patch: "text/x-diff",
};

/** Exact names allowed without an extension. */
export const ARTIFACT_EXACT_NAMES: ReadonlySet<string> = new Set([
  "Dockerfile",
  "Makefile",
  "Containerfile",
  "Procfile",
  "Gemfile",
  "Justfile",
]);

export const ARTIFACT_NAME_MAX = 128;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Why a name is not an acceptable artifact name, or undefined. */
export function artifactNameProblem(raw: string): string | undefined {
  const name = raw.trim();
  const length = Array.from(name).length;
  if (length < 1 || length > ARTIFACT_NAME_MAX) return "length";
  if (CONTROL.test(name)) return "control characters";
  if (/[/\\]/.test(name) || name.includes(":")) return "path";
  if (name === "." || name === "..") return "path";
  if (name.startsWith(".")) return "hidden";
  if (/[. ]$/.test(name)) return "trailing dot or space";
  if (ARTIFACT_EXACT_NAMES.has(name)) return undefined;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "no extension";
  if (!(name.slice(dot + 1).toLowerCase() in ARTIFACT_EXTENSIONS)) return "extension";
  return undefined;
}

export function displayMediaType(name: string): string {
  const dot = name.lastIndexOf(".");
  return (
    (dot > 0 ? ARTIFACT_EXTENSIONS[name.slice(dot + 1).toLowerCase()] : undefined) ?? "text/plain"
  );
}

/** A capture staged in the `terminal-decided` checkpoint (contracts §4.3). */
export interface StagedCapture {
  captureIndex: number;
  name: string;
  language: string | null;
  content: string;
}

export interface CaptureLimits {
  maxBytes: number;
  maxPerReply: number;
}

export interface CaptureResult {
  captures: StagedCapture[];
  /** Eligible-looking blocks that were refused, with the reason (logged without content). */
  rejected: { name: string; reason: string }[];
}

/** Tokens of an info string, honouring double-quoted values (no escapes). */
function infoTokens(info: string): string[] {
  return [...info.matchAll(/[^\s"=]+="[^"]*"|\S+/g)].map((m) => m[0]);
}

/** The `file=` value and language of an info string, or null when absent. */
export function parseInfo(info: string): { name: string; language: string | null } | null {
  const tokens = infoTokens(info.trim());
  let name: string | null = null;
  for (const token of tokens) {
    const match = /^file=(?:"([^"]*)"|(\S*))$/.exec(token);
    if (match) {
      name = match[1] ?? match[2] ?? "";
      break;
    }
  }
  if (name === null) return null;
  const first = tokens[0];
  const language = first && !first.includes("=") ? first.slice(0, 32) : null;
  return { name, language };
}

/**
 * Extracts the captures of a reply body. Deterministic: the same body always
 * yields the same captures (the body is normalized like the stored Markdown).
 */
export function captureSources(body: string, limits: CaptureLimits): CaptureResult {
  const lines = normalizeBody(body).split("\n");
  const captures: StagedCapture[] = [];
  const rejected: CaptureResult["rejected"] = [];
  let index = 0;
  for (let i = 0; i < lines.length; i++) {
    const open = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(lines[i] ?? "");
    if (!open) continue;
    const indent = open[1]?.length ?? 0;
    const fence = open[2] ?? "";
    const info = open[3] ?? "";
    if (fence.startsWith("`") && info.includes("`")) continue; // not a fence (CommonMark)
    // Find the closing fence.
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[j] ?? "");
      if (m?.[1]?.startsWith(fence.charAt(0)) && m[1].length >= fence.length) {
        close = j;
        break;
      }
    }
    if (close < 0) break; // an unclosed fence runs to the end: nothing after it counts
    const parsed = parseInfo(info);
    const bodyLines = lines
      .slice(i + 1, close)
      .map((line) => line.replace(new RegExp(`^ {0,${String(indent)}}`), ""));
    i = close;
    if (!parsed) continue;
    const name = parsed.name.trim();
    const problem = artifactNameProblem(parsed.name);
    if (problem) {
      rejected.push({ name: name.slice(0, ARTIFACT_NAME_MAX), reason: `name: ${problem}` });
      continue;
    }
    const content = bodyLines.join("\n");
    if (content.trim() === "") {
      rejected.push({ name, reason: "empty" });
      continue;
    }
    const text = `${content}\n`;
    if (Buffer.byteLength(text, "utf8") > limits.maxBytes) {
      rejected.push({ name, reason: "too large" });
      continue;
    }
    if (captures.length >= limits.maxPerReply) {
      rejected.push({ name, reason: "over the per-reply limit" });
      continue;
    }
    captures.push({ captureIndex: index++, name, language: parsed.language, content: text });
  }
  return { captures, rejected };
}
