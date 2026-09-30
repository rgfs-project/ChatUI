import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import type { LanguageFn } from "highlight.js";
import { createLowlight } from "lowlight";
import type { ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { grammarFor, type Grammar } from "../../lib/code-languages";
import "./highlight.css";

/**
 * Syntax highlighting (Phase 14): highlight.js grammars through lowlight,
 * loaded on demand (this module, then one chunk per grammar actually used).
 * The result is a hast tree of `<span class="hljs-…">` converted to React
 * elements: code text is never parsed as HTML. Only the colors change, so a
 * highlighted block has exactly the plain block's text, whitespace and layout.
 */

/** Blocks larger than this stay plain: highlighting cost is bounded. */
export const MAX_HIGHLIGHT_CHARS = 60_000;
export const MAX_HIGHLIGHT_LINES = 2_000;

type Loader = () => Promise<{ default: LanguageFn }>;

// Explicit imports, so the bundler emits exactly one chunk per listed grammar.
const LOADERS: Record<Grammar, Loader> = {
  bash: () => import("highlight.js/lib/languages/bash"),
  c: () => import("highlight.js/lib/languages/c"),
  clojure: () => import("highlight.js/lib/languages/clojure"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  css: () => import("highlight.js/lib/languages/css"),
  dart: () => import("highlight.js/lib/languages/dart"),
  diff: () => import("highlight.js/lib/languages/diff"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  elixir: () => import("highlight.js/lib/languages/elixir"),
  erlang: () => import("highlight.js/lib/languages/erlang"),
  fsharp: () => import("highlight.js/lib/languages/fsharp"),
  go: () => import("highlight.js/lib/languages/go"),
  graphql: () => import("highlight.js/lib/languages/graphql"),
  groovy: () => import("highlight.js/lib/languages/groovy"),
  haskell: () => import("highlight.js/lib/languages/haskell"),
  ini: () => import("highlight.js/lib/languages/ini"),
  java: () => import("highlight.js/lib/languages/java"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  julia: () => import("highlight.js/lib/languages/julia"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  latex: () => import("highlight.js/lib/languages/latex"),
  lua: () => import("highlight.js/lib/languages/lua"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  matlab: () => import("highlight.js/lib/languages/matlab"),
  nginx: () => import("highlight.js/lib/languages/nginx"),
  objectivec: () => import("highlight.js/lib/languages/objectivec"),
  ocaml: () => import("highlight.js/lib/languages/ocaml"),
  perl: () => import("highlight.js/lib/languages/perl"),
  php: () => import("highlight.js/lib/languages/php"),
  powershell: () => import("highlight.js/lib/languages/powershell"),
  properties: () => import("highlight.js/lib/languages/properties"),
  protobuf: () => import("highlight.js/lib/languages/protobuf"),
  python: () => import("highlight.js/lib/languages/python"),
  r: () => import("highlight.js/lib/languages/r"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  rust: () => import("highlight.js/lib/languages/rust"),
  scala: () => import("highlight.js/lib/languages/scala"),
  scss: () => import("highlight.js/lib/languages/scss"),
  sql: () => import("highlight.js/lib/languages/sql"),
  swift: () => import("highlight.js/lib/languages/swift"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  vim: () => import("highlight.js/lib/languages/vim"),
  x86asm: () => import("highlight.js/lib/languages/x86asm"),
  xml: () => import("highlight.js/lib/languages/xml"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
};

const lowlight = createLowlight();
const loading = new Map<Grammar, Promise<void>>();

function load(grammar: Grammar): Promise<void> {
  let promise = loading.get(grammar);
  if (!promise) {
    promise = LOADERS[grammar]().then((module) => {
      lowlight.register(grammar, module.default);
    });
    // A failed chunk can be retried by a later block.
    promise.catch(() => loading.delete(grammar));
    loading.set(grammar, promise);
  }
  return promise;
}

const cache = new Map<string, ReactNode>();
const CACHE_LIMIT = 200;

function tooLarge(code: string): boolean {
  if (code.length > MAX_HIGHLIGHT_CHARS) return true;
  let lines = 1;
  for (let i = code.indexOf("\n"); i !== -1; i = code.indexOf("\n", i + 1))
    if (++lines > MAX_HIGHLIGHT_LINES) return true;
  return false;
}

/** A finished highlight from the cache (remounts show it at once), or undefined. */
export function cachedHighlight(code: string, label: string | undefined): ReactNode | undefined {
  const grammar = grammarFor(label);
  return grammar ? cache.get(`${grammar}\u0000${code}`) : undefined;
}

/**
 * Highlighted children for a code element, or null when the language is
 * unknown, the block is too large, or the grammar can't be loaded (the
 * caller keeps the plain text).
 */
export async function highlight(code: string, label: string | undefined): Promise<ReactNode> {
  const grammar = grammarFor(label);
  if (!grammar || tooLarge(code)) return null;
  const key = `${grammar}\u0000${code}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  await load(grammar);
  const tree = lowlight.highlight(grammar, code);
  // Typed against a global JSX namespace React 19 no longer declares.
  const element = toJsxRuntime(tree, { Fragment, jsx, jsxs }) as unknown as ReactNode;
  const oldest = cache.keys().next();
  if (cache.size >= CACHE_LIMIT && !oldest.done) cache.delete(oldest.value);
  cache.set(key, element);
  return element;
}
