import type { CompileContext, Extension as FromMarkdownExtension } from "mdast-util-from-markdown";
import { mathFromMarkdown, type InlineMath } from "mdast-util-math";
import { math } from "micromark-extension-math";
import type {
  Code,
  Construct,
  Effects,
  Extension,
  State,
  Token,
  TokenizeContext,
} from "micromark-util-types";
// Declares the `micromarkExtensions`/`fromMarkdownExtensions` processor data.
import type {} from "remark-parse";
import type { Processor } from "unified";

declare module "micromark-util-types" {
  interface TokenTypeMap {
    chatMath: "chatMath";
    chatMathMarker: "chatMathMarker";
    chatMathData: "chatMathData";
  }
}

/**
 * Math syntax for rendering only (Phase 14). Block math is the `$$` fence of
 * `micromark-extension-math` (it may stay open while a reply streams, like a
 * code fence). Inline math uses our own tokenizer so that ordinary dollar
 * amounts stay text, following Pandoc's rule: an opening `$` is followed by a
 * non-space, a closing `$` follows a non-space and is not followed by a digit
 * (`$5 and $10` is text). A single-dollar span also contains no other
 * unescaped `$` and no backtick (code spans bind first, as in CommonMark), so a
 * stray dollar never swallows the rest of a paragraph. `$$…$$` inside a
 * paragraph is display math, and the
 * `\(…\)` / `\[…\]` delimiters many models emit are accepted too. Unclosed
 * delimiters stay literal text, a backslash inside math never closes it, and
 * `\$` outside math is an ordinary escape. The parsed value is the exact
 * source between the delimiters: display normalization never touches the
 * stored Markdown.
 */

const DOLLAR = 36;
const BACKSLASH = 92;
const BACKTICK = 96;
const PAREN_OPEN = 40;
const PAREN_CLOSE = 41;
const BRACKET_OPEN = 91;
const BRACKET_CLOSE = 93;

/** Line endings are negative codes in micromark (CR, LF, CRLF). */
function isLineEnding(code: Code): boolean {
  return code !== null && code < -2;
}
/** Spaces, tabs (and virtual spaces) or a line ending. */
function isSpaceOrEol(code: Code): boolean {
  return code !== null && (code < 0 || code === 32);
}
function isDigit(code: Code): boolean {
  return code !== null && code >= 48 && code <= 57;
}

/**
 * The shared body of an inline math span: data and line endings until the
 * closing delimiter, which `close` recognizes (as an attempt, so a failed
 * closer is ordinary data). A backslash always takes the next character with
 * it, so `\$`, `\)` and `\\` never close early.
 */
function body(
  effects: Effects,
  ok: State,
  nok: State,
  close: Construct,
  /** Whether this code may start a closer (checked before the attempt). */
  mayClose: (code: Code, previous: Code) => boolean,
  /** Characters that end the attempt when they don't close it (not math after all). */
  forbidden: (code: Code) => boolean = () => false,
): State {
  let inData = false;
  let previous: Code = null;
  let sawContent = false;

  const enterData = () => {
    if (!inData) {
      effects.enter("chatMathData");
      inData = true;
    }
  };
  const exitData = () => {
    if (inData) {
      effects.exit("chatMathData");
      inData = false;
    }
  };

  const content: State = (code) => {
    if (code === null) return nok(code);
    if (sawContent && mayClose(code, previous)) {
      exitData();
      return effects.attempt(close, done, notClosed)(code);
    }
    return forbidden(code) ? nok(code) : consume(code);
  };

  const notClosed: State = (code) => (forbidden(code) ? nok(code) : consume(code));

  const consume: State = (code) => {
    if (code === null) return nok(code);
    if (isLineEnding(code)) {
      exitData();
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      previous = code;
      sawContent = true;
      return content;
    }
    enterData();
    effects.consume(code);
    previous = code;
    sawContent = true;
    return code === BACKSLASH ? escaped : content;
  };

  const escaped: State = (code) => {
    if (code === null || isLineEnding(code)) return content(code);
    effects.consume(code);
    previous = code;
    return content;
  };

  const done: State = (code) => {
    effects.exit("chatMath");
    return ok(code);
  };

  return content;
}

/** `$…$` and `$$…$$` inside a paragraph. */
const dollarMath: Construct = {
  name: "chatMathDollar",
  tokenize(this: TokenizeContext, effects, ok, nok) {
    let size = 0;

    const closeConstruct: Construct = {
      partial: true,
      tokenize(effects, ok, nok) {
        let seen = 0;
        const sequence: State = (code) => {
          if (code === DOLLAR && seen < size) {
            effects.consume(code);
            seen++;
            return sequence;
          }
          if (seen < size || code === DOLLAR) return nok(code);
          // Pandoc: a closing single `$` is not followed by a digit.
          if (size === 1 && isDigit(code)) return nok(code);
          effects.exit("chatMathMarker");
          return ok(code);
        };
        return (code) => {
          effects.enter("chatMathMarker");
          return sequence(code);
        };
      },
    };

    const open: State = (code) => {
      if (code === DOLLAR) {
        if (size === 2) return nok(code);
        effects.consume(code);
        size++;
        return open;
      }
      effects.exit("chatMathMarker");
      // Pandoc: an opening single `$` is followed by a non-space.
      if (code === null || (size === 1 && isSpaceOrEol(code))) return nok(code);
      return body(
        effects,
        ok,
        nok,
        closeConstruct,
        (c, previous) => c === DOLLAR && !(size === 1 && isSpaceOrEol(previous)),
        (c) => size === 1 && (c === DOLLAR || c === BACKTICK),
      )(code);
    };

    return (code) => {
      effects.enter("chatMath");
      effects.enter("chatMathMarker");
      return open(code);
    };
  },
  previous(code) {
    return code !== DOLLAR;
  },
};

/** `\(…\)` and `\[…\]`: tried before the character escape of `\(`/`\[`. */
const bracketMath: Construct = {
  name: "chatMathBracket",
  add: "before",
  tokenize(effects, ok, nok) {
    let closer: number = PAREN_CLOSE;

    const closeConstruct: Construct = {
      partial: true,
      tokenize(effects, ok, nok) {
        return (code) => {
          effects.enter("chatMathMarker");
          effects.consume(code);
          return (next: Code) => {
            if (next !== closer) return nok(next);
            effects.consume(next);
            effects.exit("chatMathMarker");
            return ok;
          };
        };
      },
    };

    const kind: State = (code) => {
      if (code !== PAREN_OPEN && code !== BRACKET_OPEN) return nok(code);
      closer = code === PAREN_OPEN ? PAREN_CLOSE : BRACKET_CLOSE;
      effects.consume(code);
      effects.exit("chatMathMarker");
      return body(effects, ok, nok, closeConstruct, (c) => c === BACKSLASH);
    };

    return (code) => {
      effects.enter("chatMath");
      effects.enter("chatMathMarker");
      effects.consume(code);
      return kind;
    };
  },
};

/** The micromark extension: block `$$` fences plus the inline forms above. */
export function mathSyntax(): Extension {
  return {
    flow: math().flow,
    text: { [DOLLAR]: dollarMath, [BACKSLASH]: bracketMath },
  };
}

/** Delimiter lengths of a raw inline math span. */
function delimiters(raw: string): { open: number; close: number; display: boolean } {
  if (raw.startsWith("\\[")) return { open: 2, close: 2, display: true };
  if (raw.startsWith("\\(")) return { open: 2, close: 2, display: false };
  if (raw.startsWith("$$")) return { open: 2, close: 2, display: true };
  return { open: 1, close: 1, display: false };
}

/** mdast: inline spans become `inlineMath`, rendered as `<code class="language-math …">`. */
export function mathFromMarkdownChat(): FromMarkdownExtension {
  const flow = mathFromMarkdown();
  return {
    enter: {
      ...flow.enter,
      chatMath(this: CompileContext, token: Token) {
        const node: InlineMath = {
          type: "inlineMath",
          value: "",
          data: { hName: "code", hProperties: { className: [] }, hChildren: [] },
        };
        this.enter(node, token);
        // Inner data and line endings are discarded: the value is the raw source.
        this.buffer();
      },
    },
    exit: {
      ...flow.exit,
      chatMath(this: CompileContext, token: Token) {
        this.resume();
        const node = this.stack[this.stack.length - 1] as InlineMath;
        this.exit(token);
        const raw = this.sliceSerialize(token);
        const { open, close, display } = delimiters(raw);
        node.value = raw.slice(open, raw.length - close);
        node.data = {
          hName: "code",
          hProperties: {
            className: ["language-math", display ? "math-display" : "math-inline"],
          },
          hChildren: [{ type: "text", value: node.value }],
        };
      },
    },
  };
}

/** Remark plugin: registers the syntax and its mdast conversion. */
export function remarkMathParse(this: Processor): undefined {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(mathSyntax());
  (data.fromMarkdownExtensions ??= []).push(mathFromMarkdownChat());
  return undefined;
}
