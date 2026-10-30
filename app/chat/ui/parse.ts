// Intelligent UI blocks (Phase 14b, docs/threat-model-14b.md): a ```ui fence
// is parsed into a tree of allowlisted nodes whose fields are plain strings and
// numbers. Nothing is evaluated. Linear time, bounded size. Zod-free (browser).

export const UI_LIMITS = {
  source: 20_000,
  nodes: 300,
  depth: 4,
  text: 1_000,
  tabs: 12,
  options: 8,
  points: 40,
  stats: 24,
  items: 50,
} as const;

export type Tone = "info" | "tip" | "warning" | "success";
const TONES: readonly Tone[] = ["info", "tip", "warning", "success"];

export type UiNode =
  | { type: "callout"; tone: Tone; text: string }
  | { type: "card"; title: string; children: UiNode[] }
  | { type: "text"; text: string }
  | { type: "steps"; ordered: boolean; items: string[] }
  | { type: "tabs"; tabs: { label: string; children: UiNode[] }[] }
  | { type: "stats"; stats: { label: string; value: string; note: string | null }[] }
  | {
      type: "chart";
      kind: "bar" | "line";
      title: string;
      points: { label: string; value: number }[];
    }
  | {
      type: "quiz";
      question: string;
      options: { text: string; correct: boolean }[];
      explain: string | null;
    }
  | { type: "progress"; label: string; value: number }
  | { type: "divider" };

export type ParseOutcome = { ok: true; nodes: UiNode[] } | { ok: false; reason: string };

class Bound extends Error {}

const clip = (value: string) => value.slice(0, UI_LIMITS.text);
const NUMBER = /^-?\d{1,15}(?:\.\d{1,6})?$/;

interface Line {
  indent: number;
  text: string;
}

function lines(source: string): Line[] {
  const out: Line[] = [];
  for (const raw of source.split("\n")) {
    const trimmed = raw.replace(/\s+$/, "");
    if (trimmed.trim() === "") continue;
    const indent = trimmed.length - trimmed.trimStart().length;
    out.push({ indent, text: trimmed.trimStart() });
  }
  return out;
}

/** `head rest…` → [head, rest]. */
function split(text: string): [string, string] {
  const space = text.indexOf(" ");
  return space < 0 ? [text, ""] : [text.slice(0, space), text.slice(space + 1).trim()];
}

/** `label = value` (the last ` = ` splits, so labels may contain "="). */
function pair(text: string): [string, string] | null {
  const at = text.lastIndexOf(" = ");
  if (at < 0) return null;
  return [text.slice(0, at).trim(), text.slice(at + 3).trim()];
}

function parseStatements(source: string): UiNode[] {
  const all = lines(source);
  let pos = 0;
  let count = 0;
  const node = <T extends UiNode>(n: T): T => {
    if (++count > UI_LIMITS.nodes) throw new Bound("too many parts");
    return n;
  };
  // Children of the statement at `indent`: following lines indented deeper.
  const childLines = (indent: number): Line[] => {
    const out: Line[] = [];
    while (pos < all.length && (all[pos]?.indent ?? 0) > indent) {
      const line = all[pos];
      if (line) out.push(line);
      pos++;
    }
    return out;
  };
  const block = (indent: number, depth: number): UiNode[] => {
    if (depth > UI_LIMITS.depth) throw new Bound("nested too deeply");
    const out: UiNode[] = [];
    while (pos < all.length && (all[pos]?.indent ?? 0) >= indent) {
      const line = all[pos];
      pos++;
      if (!line) continue;
      const [head, rest] = split(line.text);
      const level = line.indent;
      switch (head) {
        case "callout": {
          const [maybeTone, text] = split(rest);
          const tone = TONES.find((t) => t === maybeTone);
          const body = [tone ? text : rest, ...childLines(level).map((l) => l.text)].join(" ");
          out.push(node({ type: "callout", tone: tone ?? "info", text: clip(body) }));
          break;
        }
        case "card": {
          out.push(node({ type: "card", title: clip(rest), children: nested(level, depth) }));
          break;
        }
        case "text":
          out.push(node({ type: "text", text: clip(rest) }));
          break;
        case "steps":
        case "list": {
          const items = childLines(level)
            .map((l) => l.text.replace(/^(?:[-*]|\d+[.)])\s*/, ""))
            .filter((t) => t !== "")
            .slice(0, UI_LIMITS.items)
            .map(clip);
          out.push(node({ type: "steps", ordered: head === "steps", items }));
          break;
        }
        case "tabs": {
          const tabs: { label: string; children: UiNode[] }[] = [];
          while (pos < all.length && (all[pos]?.indent ?? 0) > level) {
            const tab = all[pos];
            pos++;
            if (!tab) continue;
            const [kind, label] = split(tab.text);
            if (kind !== "tab") throw new Bound(`expected "tab" inside tabs`);
            if (tabs.length >= UI_LIMITS.tabs) throw new Bound("too many tabs");
            tabs.push({
              label: clip(label || `Tab ${String(tabs.length + 1)}`),
              children: nested(tab.indent, depth + 1),
            });
          }
          out.push(node({ type: "tabs", tabs }));
          break;
        }
        case "stats": {
          const stats = childLines(level)
            .map((l) => {
              const [kind, body] = split(l.text);
              const p = kind === "stat" ? pair(body) : null;
              if (!p) return null;
              const [value, note] = p[1].split(" | ");
              return {
                label: clip(p[0]),
                value: clip(value ?? ""),
                note: note ? clip(note) : null,
              };
            })
            .filter((s): s is { label: string; value: string; note: string | null } => s !== null);
          if (stats.length > UI_LIMITS.stats) throw new Bound("too many stats");
          out.push(node({ type: "stats", stats }));
          break;
        }
        case "chart": {
          const [kindRaw, title] = split(rest);
          const kind = kindRaw === "line" ? "line" : "bar";
          const points = childLines(level).flatMap((l) => {
            const p = pair(l.text);
            if (!p || !NUMBER.test(p[1])) return [];
            const value = Number(p[1]);
            return Number.isFinite(value) ? [{ label: clip(p[0]), value }] : [];
          });
          if (points.length > UI_LIMITS.points) throw new Bound("too many chart points");
          out.push(
            node({
              type: "chart",
              kind,
              title: clip(kindRaw === "bar" || kindRaw === "line" ? title : rest),
              points,
            }),
          );
          break;
        }
        case "quiz": {
          const options: { text: string; correct: boolean }[] = [];
          let explain: string | null = null;
          for (const l of childLines(level)) {
            const [kind, body] = split(l.text);
            if (kind === "option" || kind === "option*")
              options.push({ text: clip(body), correct: kind === "option*" });
            else if (kind === "explain") explain = clip(body);
          }
          if (options.length > UI_LIMITS.options) throw new Bound("too many quiz options");
          out.push(node({ type: "quiz", question: clip(rest), options, explain }));
          break;
        }
        case "progress": {
          const p = pair(rest);
          const value = p && NUMBER.test(p[1]) ? Number(p[1]) : 0;
          out.push(
            node({
              type: "progress",
              label: clip(p ? p[0] : rest),
              value: Math.min(100, Math.max(0, value)),
            }),
          );
          break;
        }
        case "divider":
          out.push(node({ type: "divider" }));
          break;
        default:
          throw new Bound(`unknown statement "${head.slice(0, 20)}"`);
      }
    }
    return out;
  };
  const nested = (indent: number, depth: number): UiNode[] => {
    const next = all[pos];
    if (!next || next.indent <= indent) return [];
    return block(next.indent, depth + 1);
  };
  return block(all[0]?.indent ?? 0, 1);
}

// --- JSON form -------------------------------------------------------------

const str = (v: unknown): string =>
  typeof v === "string" ? clip(v) : typeof v === "number" ? String(v) : "";

function fromJson(value: unknown, depth: number, count: { n: number }): UiNode[] {
  if (depth > UI_LIMITS.depth) throw new Bound("nested too deeply");
  const list = Array.isArray(value) ? value : [value];
  return list.map((raw): UiNode => {
    if (++count.n > UI_LIMITS.nodes) throw new Bound("too many parts");
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw new Bound("each part must be an object");
    // Only own, known fields are read: prototype keys mean nothing here.
    const o = new Map(Object.entries(raw as Record<string, unknown>));
    const children = (key: string) => fromJson(o.get(key) ?? [], depth + 1, count);
    switch (o.get("type")) {
      case "callout": {
        const tone = TONES.find((t) => t === o.get("tone")) ?? "info";
        return { type: "callout", tone, text: str(o.get("text")) };
      }
      case "card":
        return { type: "card", title: str(o.get("title")), children: children("children") };
      case "text":
        return { type: "text", text: str(o.get("text")) };
      case "steps":
      case "list": {
        const items = o.get("items");
        return {
          type: "steps",
          ordered: o.get("type") === "steps",
          items: Array.isArray(items) ? items.slice(0, UI_LIMITS.items).map(str) : [],
        };
      }
      case "tabs": {
        const tabs = o.get("tabs");
        if (!Array.isArray(tabs) || tabs.length > UI_LIMITS.tabs)
          throw new Bound("tabs need 1–12 tabs");
        return {
          type: "tabs",
          tabs: tabs.map((t: unknown) => {
            const tab = new Map(Object.entries((t ?? {}) as Record<string, unknown>));
            return {
              label: str(tab.get("label")),
              children: fromJson(tab.get("children") ?? [], depth + 1, count),
            };
          }),
        };
      }
      case "stats": {
        const stats = o.get("stats");
        if (!Array.isArray(stats) || stats.length > UI_LIMITS.stats)
          throw new Bound("too many stats");
        return {
          type: "stats",
          stats: stats.map((s: unknown) => {
            const m = new Map(Object.entries((s ?? {}) as Record<string, unknown>));
            const note = m.get("note");
            return {
              label: str(m.get("label")),
              value: str(m.get("value")),
              note: note === undefined ? null : str(note),
            };
          }),
        };
      }
      case "chart": {
        const points = o.get("points");
        if (!Array.isArray(points) || points.length > UI_LIMITS.points)
          throw new Bound("too many chart points");
        return {
          type: "chart",
          kind: o.get("kind") === "line" ? "line" : "bar",
          title: str(o.get("title")),
          points: points.flatMap((p: unknown) => {
            const m = new Map(Object.entries((p ?? {}) as Record<string, unknown>));
            const v = m.get("value");
            return typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e15
              ? [{ label: str(m.get("label")), value: v }]
              : [];
          }),
        };
      }
      case "quiz": {
        const options = o.get("options");
        if (!Array.isArray(options) || options.length > UI_LIMITS.options)
          throw new Bound("too many quiz options");
        const explain = o.get("explain");
        return {
          type: "quiz",
          question: str(o.get("question")),
          options: options.map((x: unknown) => {
            const m = new Map(Object.entries((x ?? {}) as Record<string, unknown>));
            return { text: str(m.get("text")), correct: m.get("correct") === true };
          }),
          explain: explain === undefined ? null : str(explain),
        };
      }
      case "progress": {
        const v = o.get("value");
        return {
          type: "progress",
          label: str(o.get("label")),
          value: typeof v === "number" && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0,
        };
      }
      case "divider":
        return { type: "divider" };
      default:
        throw new Bound("unknown part type");
    }
  });
}

const cache = new Map<string, ParseOutcome>();

/**
 * Parses a block. While a reply streams, pass `complete: false`: the last
 * (possibly unfinished) line is left out, and a JSON block that doesn't parse
 * yet is reported as not ready.
 */
export function parseUiBlock(source: string, complete = true): ParseOutcome {
  const key = `${complete ? "1" : "0"}${source}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let outcome: ParseOutcome;
  try {
    if (source.length > UI_LIMITS.source) throw new Bound("the block is too long");
    const json = /^\s*[[{]/.test(source);
    if (json) {
      let value: unknown;
      try {
        value = JSON.parse(source);
      } catch {
        throw new Bound(complete ? "the block is not valid JSON" : "not ready");
      }
      outcome = { ok: true, nodes: fromJson(value, 1, { n: 0 }) };
    } else {
      const text = complete ? source : source.slice(0, Math.max(0, source.lastIndexOf("\n")));
      outcome = { ok: true, nodes: parseStatements(text) };
    }
    // Nothing to show yet (or an empty block): the source is shown instead.
    if (outcome.nodes.length === 0) throw new Bound(complete ? "the block is empty" : "not ready");
  } catch (error) {
    outcome = {
      ok: false,
      reason: error instanceof Bound ? error.message : "the block could not be read",
    };
  }
  if (cache.size > 200) cache.clear();
  cache.set(key, outcome);
  return outcome;
}
