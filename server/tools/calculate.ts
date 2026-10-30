// `calculate` (D2 general tools): a small arithmetic interpreter. It parses
// with recursive descent and never uses eval or Function. Bounded input,
// bounded nesting.

export const CALC_MAX_LENGTH = 200;
const MAX_DEPTH = 32;

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  ln: Math.log,
  log: Math.log10,
  exp: Math.exp,
  min: Math.min,
  max: Math.max,
};
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

type Token =
  { kind: "num"; value: number } | { kind: "id"; value: string } | { kind: "op"; value: string };

export class CalcError extends Error {
  override name = "CalcError";
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] ?? "";
    if (/\s/.test(ch)) {
      i++;
    } else if (/[0-9.]/.test(ch)) {
      const match = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(input.slice(i));
      if (!match) throw new CalcError("Invalid number");
      tokens.push({ kind: "num", value: Number(match[0]) });
      i += match[0].length;
    } else if (/[a-z]/i.test(ch)) {
      const match = /^[a-z]+/i.exec(input.slice(i));
      const word = (match?.[0] ?? "").toLowerCase();
      tokens.push({ kind: "id", value: word });
      i += word.length;
    } else if ("+-*/%^(),".includes(ch)) {
      tokens.push({ kind: "op", value: ch });
      i++;
    } else if (ch === "×") {
      tokens.push({ kind: "op", value: "*" });
      i++;
    } else if (ch === "÷") {
      tokens.push({ kind: "op", value: "/" });
      i++;
    } else {
      throw new CalcError(`Unexpected character "${ch}"`);
    }
  }
  return tokens;
}

/** Evaluates an arithmetic expression; throws CalcError on anything else. */
export function calculate(expression: string): number {
  if (expression.length > CALC_MAX_LENGTH) throw new CalcError("The expression is too long");
  const tokens = tokenize(expression);
  let pos = 0;
  let depth = 0;
  const peek = () => tokens[pos];
  const isOp = (value: string) => {
    const t = peek();
    return t?.kind === "op" && t.value === value;
  };
  const expect = (value: string) => {
    if (!isOp(value)) throw new CalcError(`Expected "${value}"`);
    pos++;
  };
  const nest = <T>(fn: () => T): T => {
    if (++depth > MAX_DEPTH) throw new CalcError("The expression is nested too deeply");
    try {
      return fn();
    } finally {
      depth--;
    }
  };

  // expr := term (("+" | "-") term)*
  const expr = (): number =>
    nest(() => {
      let value = term();
      while (isOp("+") || isOp("-")) {
        const op = (peek() as { value: string }).value;
        pos++;
        value = op === "+" ? value + term() : value - term();
      }
      return value;
    });
  // term := unary (("*" | "/" | "%") unary)*
  const term = (): number => {
    let value = unary();
    while (isOp("*") || isOp("/") || isOp("%")) {
      const op = (peek() as { value: string }).value;
      pos++;
      const right = unary();
      value = op === "*" ? value * right : op === "/" ? value / right : value % right;
    }
    return value;
  };
  // unary := ("-" | "+") unary | power
  const unary = (): number =>
    nest(() => {
      if (isOp("-")) {
        pos++;
        return -unary();
      }
      if (isOp("+")) {
        pos++;
        return unary();
      }
      return power();
    });
  // power := primary ("^" unary)?   (right-associative)
  const power = (): number => {
    const base = primary();
    if (isOp("^")) {
      pos++;
      return base ** unary();
    }
    return base;
  };
  const primary = (): number => {
    const token = peek();
    if (!token) throw new CalcError("Unexpected end of expression");
    if (token.kind === "num") {
      pos++;
      return token.value;
    }
    if (token.kind === "id") {
      pos++;
      const fn = FUNCTIONS[token.value];
      if (fn) {
        expect("(");
        const args = [expr()];
        while (isOp(",")) {
          pos++;
          args.push(expr());
        }
        expect(")");
        if (fn.length > 0 && args.length !== fn.length && fn !== Math.min && fn !== Math.max)
          throw new CalcError(`${token.value} takes ${String(fn.length)} argument(s)`);
        return fn(...args);
      }
      const constant = CONSTANTS[token.value];
      if (constant !== undefined) return constant;
      throw new CalcError(`Unknown name "${token.value}"`);
    }
    if (isOp("(")) {
      pos++;
      const value = expr();
      expect(")");
      return value;
    }
    throw new CalcError(`Unexpected "${token.value}"`);
  };

  if (tokens.length === 0) throw new CalcError("The expression is empty");
  const value = expr();
  if (pos !== tokens.length) throw new CalcError("Unexpected text after the expression");
  if (!Number.isFinite(value)) throw new CalcError("The result is not a finite number");
  return value;
}

/** A readable result: integers as they are, otherwise up to 12 significant digits. */
export function formatNumber(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e21) return String(value);
  return String(Number(value.toPrecision(12)));
}
