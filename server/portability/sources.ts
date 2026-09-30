// The import sources this instance reads (Phase 13e). Order matters only for
// detection: the first adapter that recognizes an upload converts it.
import { chatuiAdapter, type ImportAdapter } from "./adapters.ts";
import { claudeAdapter } from "./claude.ts";
import { duckaiAdapter } from "./duckai.ts";

export const IMPORT_ADAPTERS: readonly ImportAdapter[] = [
  chatuiAdapter,
  claudeAdapter,
  duckaiAdapter,
];
