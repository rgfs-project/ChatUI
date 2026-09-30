/**
 * Code block languages (Phase 14): the fence label a model writes → the
 * grammar that highlights it and the extension of a downloaded copy. Small
 * and synchronous; the grammars themselves load on demand.
 */

/** Canonical grammar names (highlight.js) with a lazy loader in `highlight.ts`. */
export const GRAMMARS = [
  "bash",
  "c",
  "clojure",
  "cpp",
  "csharp",
  "css",
  "dart",
  "diff",
  "dockerfile",
  "elixir",
  "erlang",
  "fsharp",
  "go",
  "graphql",
  "groovy",
  "haskell",
  "ini",
  "java",
  "javascript",
  "json",
  "julia",
  "kotlin",
  "latex",
  "lua",
  "makefile",
  "markdown",
  "matlab",
  "nginx",
  "objectivec",
  "ocaml",
  "perl",
  "php",
  "powershell",
  "properties",
  "protobuf",
  "python",
  "r",
  "ruby",
  "rust",
  "scala",
  "scss",
  "sql",
  "swift",
  "typescript",
  "vim",
  "x86asm",
  "xml",
  "yaml",
] as const;
export type Grammar = (typeof GRAMMARS)[number];

const ALIASES: Record<string, Grammar> = {
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  "c++": "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  h: "c",
  cs: "csharp",
  "c#": "csharp",
  clj: "clojure",
  docker: "dockerfile",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  "f#": "fsharp",
  fs: "fsharp",
  golang: "go",
  gql: "graphql",
  hs: "haskell",
  toml: "ini",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  jsonc: "json",
  json5: "json",
  jl: "julia",
  kt: "kotlin",
  kts: "kotlin",
  tex: "latex",
  make: "makefile",
  mk: "makefile",
  md: "markdown",
  objc: "objectivec",
  ml: "ocaml",
  pl: "perl",
  ps1: "powershell",
  pwsh: "powershell",
  proto: "protobuf",
  py: "python",
  python3: "python",
  rb: "ruby",
  rs: "rust",
  sc: "scala",
  patch: "diff",
  asm: "x86asm",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  html: "xml",
  htm: "xml",
  xhtml: "xml",
  svg: "xml",
  vue: "xml",
  yml: "yaml",
};

/** The grammar for a fence label, or null (plain text) when there is none. */
export function grammarFor(label: string | undefined): Grammar | null {
  if (!label) return null;
  const name = label.toLowerCase();
  if ((GRAMMARS as readonly string[]).includes(name)) return name as Grammar;
  return ALIASES[name] ?? null;
}

const EXTENSIONS: Partial<Record<Grammar, string>> = {
  bash: "sh",
  clojure: "clj",
  cpp: "cpp",
  csharp: "cs",
  dockerfile: "Dockerfile",
  elixir: "ex",
  erlang: "erl",
  fsharp: "fs",
  haskell: "hs",
  javascript: "js",
  julia: "jl",
  kotlin: "kt",
  latex: "tex",
  makefile: "mk",
  markdown: "md",
  objectivec: "m",
  ocaml: "ml",
  perl: "pl",
  powershell: "ps1",
  protobuf: "proto",
  python: "py",
  ruby: "rb",
  rust: "rs",
  typescript: "ts",
  x86asm: "asm",
  yaml: "yml",
};

/** A download name for a code block: `snippet.<ext>`, or `.txt` when unknown. */
export function downloadName(label: string | undefined): string {
  const grammar = grammarFor(label);
  // A literal `tsx`/`jsx`/`html` label keeps its own extension.
  const literal = label?.toLowerCase();
  if (literal && /^(tsx|jsx|html|toml|svg|vue)$/.test(literal)) return `snippet.${literal}`;
  if (!grammar) return "snippet.txt";
  const ext = EXTENSIONS[grammar] ?? grammar;
  return ext === "Dockerfile" ? "Dockerfile" : `snippet.${ext}`;
}
