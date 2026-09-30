import type { ReactNode } from "react";
import type * as HighlightExports from "../components/code/highlight";
import type * as MathExports from "../components/math/MathView";

/**
 * On-demand answer renderers (Phase 14): the math renderer and the syntax
 * highlighter are separate chunks, requested only when a message contains
 * math or a labelled code block. Nothing here is imported eagerly.
 */

type MathModule = typeof MathExports;
type HighlightModule = typeof HighlightExports;

/** A promise carrying its settled state, which React's `use()` reads synchronously. */
type Tracked<T> = Promise<T> & { status?: "pending" | "fulfilled" | "rejected"; value?: T };

function track<T>(promise: Promise<T>): Tracked<T> {
  const tracked = promise as Tracked<T>;
  tracked.status = "pending";
  tracked.then(
    (value) => {
      tracked.status = "fulfilled";
      tracked.value = value;
    },
    () => {
      tracked.status = "rejected";
    },
  );
  return tracked;
}

let math: Tracked<MathModule> | undefined;

/**
 * The math renderer module. A failed chunk load is retried on the next call.
 * The server preloads it (`preloadRenderers`), so server HTML always carries
 * rendered math; the browser hydrates it when its chunk arrives.
 */
export function loadMath(): Promise<MathModule> {
  if (!math || math.status === "rejected") math = track(import("../components/math/MathView"));
  return math;
}

let highlighter: HighlightModule | undefined;
let highlighterLoad: Promise<HighlightModule> | undefined;
const listeners = new Set<() => void>();

export function subscribeHighlights(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The finished highlight of this block, if one is cached. */
export function highlightSnapshot(code: string, label: string | undefined): ReactNode {
  return highlighter?.cachedHighlight(code, label) ?? null;
}

/** Highlights a block in the background; subscribers hear when it is ready. */
export function requestHighlight(code: string, label: string | undefined): void {
  highlighterLoad ??= import("../components/code/highlight").then((module) => {
    highlighter = module;
    return module;
  });
  highlighterLoad
    .then((module) => module.highlight(code, label))
    .then(
      (node) => {
        if (node !== null) for (const listener of listeners) listener();
      },
      () => {
        // The chunk failed to load (or a grammar did): the block stays plain.
        if (!highlighter) highlighterLoad = undefined;
      },
    );
}

/** Server start: the math module is ready before the first document render. */
export function preloadRenderers(): Promise<unknown> {
  return loadMath();
}
