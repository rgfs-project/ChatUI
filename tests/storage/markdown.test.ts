import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  normalizeBody,
  parseConversation,
  serializeConversation,
  type Block,
  type ConversationModel,
} from "../../server/storage/markdown.ts";

const U1 = "0b7e7c2a-1111-4a1a-8a1a-111111111111";
const U2 = "9d44e1f0-2222-4b2b-9b2b-222222222222";
const U3 = "6f1c0d9e-3333-4c3c-8c3c-333333333333";
const A1 = "a1f2a1f2-4444-4d4d-8d4d-444444444444";
const A2 = "c93dc93d-5555-4e5e-9e5e-555555555555";
const T = "2026-09-11T17:03:12.000Z";

const FRONT = `---\nformatVersion: 1\ntitle: "Trip planning"\ncreatedAt: "${T}"\nupdatedAt: "2026-09-11T17:05:40.512Z"\n---\n`;

function ok(text: string): ConversationModel {
  const result = parseConversation(text);
  if (!result.ok)
    throw new Error(`expected ok, got: ${result.reason} (line ${String(result.line)})`);
  return result.conversation;
}

function bad(text: string): string {
  const result = parseConversation(text);
  if (result.ok) throw new Error("expected malformed");
  return result.reason;
}

const sample = `${FRONT}
<!-- cc:system id=${U3} -->
You are a concise assistant.

<!-- cc:user id=${U1} attachments="${A1},${A2}" time="${T}" -->
What's in these photos?

<!-- cc:reasoning id=${U2} -->
The user attached two images…

<!-- cc:assistant id=${U2} status=complete provider="local" model="qwen3-8b-q4_k_m" time="${T}" -->
The first photo shows…
`;

describe("INV-09: formatVersion 1 parsing (contracts §3)", () => {
  it("parses the canonical example into the model", () => {
    const model = ok(sample);
    expect(model.title).toBe("Trip planning");
    expect(model.blocks.map((b) => b.type)).toEqual(["system", "user", "reasoning", "assistant"]);
    expect(model.blocks[1]).toEqual({
      type: "user",
      id: U1,
      attachments: [A1, A2],
      time: T,
      body: "What's in these photos?",
    });
    expect(model.blocks[3]).toMatchObject({
      status: "complete",
      provider: "local",
      model: "qwen3-8b-q4_k_m",
    });
  });

  it("serializes the canonical example back to identical bytes", () => {
    expect(serializeConversation(ok(sample))).toBe(sample);
  });

  it("accepts a zero-message conversation", () => {
    expect(ok(FRONT).blocks).toEqual([]);
    expect(serializeConversation(ok(FRONT))).toBe(FRONT);
  });

  it("drops a leading BOM, accepts CRLF and mixed endings, keeps a lone CR as content", () => {
    const crlf = `\ufeff${sample.replace(/\n/g, "\r\n")}`;
    expect(ok(crlf)).toEqual(ok(sample));
    const loneCr = `${FRONT}\n<!-- cc:user id=${U1} -->\na\rb\r\n`;
    expect(ok(loneCr).blocks[0]?.body).toBe("a\rb");
  });

  it("strips insignificant leading/trailing blank lines but keeps inner bytes exactly", () => {
    const text = `${FRONT}\n\n\n<!-- cc:user id=${U1} -->\n\n  \n  indented  \n\n\tinner\n\n\n`;
    expect(ok(text).blocks[0]?.body).toBe("  indented  \n\n\tinner");
  });

  it("accepts attributes in any order and extra whitespace in delimiters", () => {
    const text = `${FRONT}\n \t<!--\tcc:assistant   status=failed \t id=${U2}\t--> \t\n`;
    expect(ok(text).blocks[0]).toEqual({ type: "assistant", id: U2, status: "failed", body: "" });
  });

  it("accepts BARE and QUOTED values where the grammar allows both", () => {
    const text = `${FRONT}\n<!-- cc:assistant id="${U2}" status="complete" provider=local model=m.1-x_y -->\n`;
    expect(ok(text).blocks[0]).toMatchObject({ provider: "local", model: "m.1-x_y" });
  });

  it("decodes JSON escapes in quoted values", () => {
    const text = `${FRONT}\n<!-- cc:assistant id=${U2} status=complete model="a\\u003c-->\\"b" -->\n`;
    expect(ok(text).blocks[0]).toMatchObject({ model: 'a<-->"b' });
  });

  it("removes exactly one backslash from escaped delimiter-like content lines", () => {
    const text = `${FRONT}\n<!-- cc:user id=${U1} -->\n\\<!-- cc:user id=x -->\n\\\\  <!--cc:foo\n`;
    expect(ok(text).blocks[0]?.body).toBe("<!-- cc:user id=x -->\n\\  <!--cc:foo");
  });
});

describe("INV-09: malformed input is reported, never thrown", () => {
  const delim = (d: string) => `${FRONT}\n${d}\nbody\n`;
  it.each([
    ["unknown type", `<!-- cc:tool id=${U1} -->`],
    ["unknown attribute", `<!-- cc:user id=${U1} foo=bar -->`],
    ["duplicate attribute", `<!-- cc:user id=${U1} id=${U1} -->`],
    ["attribute not allowed on type", `<!-- cc:user id=${U1} status=complete -->`],
    ["system with time", `<!-- cc:system id=${U1} time="${T}" -->`],
    ["missing id", "<!-- cc:user -->"],
    ["uppercase uuid", `<!-- cc:user id=${U1.toUpperCase()} -->`],
    ["non-uuid id", "<!-- cc:user id=abc -->"],
    ["assistant without status", `<!-- cc:assistant id=${U2} -->`],
    ["invalid status", `<!-- cc:assistant id=${U2} status=done -->`],
    ["bare attachments", `<!-- cc:user id=${U1} attachments=${A1} -->`],
    ["attachments with spaces", `<!-- cc:user id=${U1} attachments="${A1}, ${A2}" -->`],
    ["11 attachments", `<!-- cc:user id=${U1} attachments="${Array(11).fill(A1).join(",")}" -->`],
    ["bare time", `<!-- cc:user id=${U1} time=2026-09-11T17:03:12.000Z -->`],
    ["non-canonical time", `<!-- cc:user id=${U1} time="2026-09-11T17:03:12Z" -->`],
    ["impossible date", `<!-- cc:user id=${U1} time="2026-02-30T00:00:00.000Z" -->`],
    ["missing whitespace between attributes", `<!-- cc:assistant id=${U2}status=complete -->`],
    ["whitespace after cc:", `<!-- cc: user id=${U1} -->`],
    ["unterminated delimiter", `<!-- cc:user id=${U1}`],
    ["text after -->", `<!-- cc:user id=${U1} --> trailing`],
    ["invalid quoted escape", `<!-- cc:assistant id=${U2} status=complete model="a\\x" -->`],
    ["bad bare characters", `<!-- cc:assistant id=${U2} status=complete model=a/b -->`],
  ])("rejects %s", (_name, line) => {
    expect(bad(delim(line))).toBeTruthy();
  });

  it("rejects text before the first delimiter", () => {
    expect(bad(`${FRONT}\nstray\n<!-- cc:user id=${U1} -->\n`)).toMatch(/before the first/);
  });

  it("rejects duplicate ids", () => {
    expect(bad(`${FRONT}\n<!-- cc:user id=${U1} -->\n\n<!-- cc:user id=${U1} -->\n`)).toMatch(
      /duplicate id/,
    );
  });

  it.each([
    ["reasoning without assistant", `<!-- cc:reasoning id=${U2} -->\nr\n`],
    [
      "reasoning before a different assistant",
      `<!-- cc:reasoning id=${U2} -->\nr\n\n<!-- cc:assistant id=${U1} status=complete -->\n`,
    ],
    [
      "reasoning separated by a user block",
      `<!-- cc:reasoning id=${U2} -->\n\n<!-- cc:user id=${U1} -->\n\n<!-- cc:assistant id=${U2} status=complete -->\n`,
    ],
    [
      "two reasoning blocks",
      `<!-- cc:reasoning id=${U2} -->\n\n<!-- cc:reasoning id=${U2} -->\n\n<!-- cc:assistant id=${U2} status=complete -->\n`,
    ],
  ])("enforces reasoning/assistant adjacency: %s", (_name, body) => {
    expect(bad(`${FRONT}\n${body}`)).toBeTruthy();
  });

  const fm = (lines: string) => `---\n${lines}\n---\n`;
  it.each([
    ["missing key", `formatVersion: 1\ntitle: "t"\ncreatedAt: "${T}"`],
    ["extra key", `formatVersion: 1\ntitle: "t"\ncreatedAt: "${T}"\nupdatedAt: "${T}"\nextra: 1`],
    [
      "duplicate key",
      `formatVersion: 1\ntitle: "t"\ntitle: "u"\ncreatedAt: "${T}"\nupdatedAt: "${T}"`,
    ],
    ["reordered keys", `title: "t"\nformatVersion: 1\ncreatedAt: "${T}"\nupdatedAt: "${T}"`],
    ["version 2", `formatVersion: 2\ntitle: "t"\ncreatedAt: "${T}"\nupdatedAt: "${T}"`],
    ["float version", `formatVersion: 1.0\ntitle: "t"\ncreatedAt: "${T}"\nupdatedAt: "${T}"`],
    ["string version", `formatVersion: "1"\ntitle: "t"\ncreatedAt: "${T}"\nupdatedAt: "${T}"`],
    ["empty title", `formatVersion: 1\ntitle: ""\ncreatedAt: "${T}"\nupdatedAt: "${T}"`],
    [
      "201-char title",
      `formatVersion: 1\ntitle: "${"x".repeat(201)}"\ncreatedAt: "${T}"\nupdatedAt: "${T}"`,
    ],
    [
      "title with line break",
      `formatVersion: 1\ntitle: "a\\nb"\ncreatedAt: "${T}"\nupdatedAt: "${T}"`,
    ],
    ["numeric title", `formatVersion: 1\ntitle: 5\ncreatedAt: "${T}"\nupdatedAt: "${T}"`],
    ["bad timestamp", `formatVersion: 1\ntitle: "t"\ncreatedAt: "yesterday"\nupdatedAt: "${T}"`],
    ["not a mapping", "- a\n- b"],
    ["invalid yaml", "formatVersion: [1"],
  ])("rejects front matter: %s", (_name, lines) => {
    expect(bad(fm(lines))).toBeTruthy();
  });

  it("rejects files without front matter or with unclosed front matter", () => {
    expect(bad("hello")).toMatch(/front matter/);
    expect(bad("---\nformatVersion: 1\n")).toMatch(/not closed/);
    expect(bad(`\n${FRONT}`)).toMatch(/front matter/);
  });

  it("accepts exactly 200 characters (code points) in a title", () => {
    const title = "😀".repeat(200);
    expect(
      ok(`---\nformatVersion: 1\ntitle: "${title}"\ncreatedAt: "${T}"\nupdatedAt: "${T}"\n---\n`)
        .title,
    ).toBe(title);
  });
});

describe("serializer", () => {
  it("emits canonical attribute order, single spaces and quoted provider/model/attachments/time", () => {
    const text = serializeConversation({
      title: "t",
      createdAt: T,
      updatedAt: T,
      blocks: [
        { type: "user", id: U1, time: T, attachments: [A1], body: "q" },
        {
          type: "assistant",
          id: U2,
          status: "complete",
          time: T,
          model: "m",
          provider: "p",
          body: "a",
        },
      ],
    });
    expect(text).toContain(`<!-- cc:user id=${U1} attachments="${A1}" time="${T}" -->\nq\n\n`);
    expect(text).toContain(
      `<!-- cc:assistant id=${U2} status=complete provider="p" model="m" time="${T}" -->\na\n`,
    );
    expect(text.endsWith("a\n")).toBe(true);
  });

  it("escapes <, > and & in quoted values so --> can never appear inside a value", () => {
    const text = serializeConversation({
      title: "<b>&</b> -->",
      createdAt: T,
      updatedAt: T,
      blocks: [{ type: "assistant", id: U2, status: "complete", model: "x-->y<&>", body: "" }],
    });
    expect(text).not.toMatch(/model="[^"]*-->/);
    const u = (hex: string) => `\\u${hex}`;
    expect(text).toContain(
      `title: "${u("003c")}b${u("003e")}${u("0026")}${u("003c")}/b${u("003e")} --${u("003e")}"`,
    );
    expect(ok(text).title).toBe("<b>&</b> -->");
  });

  it("escapes delimiter-like body lines, including ones with existing backslashes", () => {
    const body = "<!-- cc:user id=x -->\n\\<!-- cc:x\n  <!--  cc:";
    const text = serializeConversation({
      title: "t",
      createdAt: T,
      updatedAt: T,
      blocks: [{ type: "user", id: U1, body }],
    });
    expect(text).toContain("\\<!-- cc:user id=x -->\n\\\\<!-- cc:x\n\\  <!--  cc:");
    expect(ok(text).blocks[0]?.body).toBe(body);
  });

  it("writes empty bodies and ends the file with exactly one newline", () => {
    const text = serializeConversation({
      title: "t",
      createdAt: T,
      updatedAt: T,
      blocks: [
        { type: "user", id: U1, body: "" },
        { type: "assistant", id: U2, status: "failed", body: "" },
      ],
    });
    expect(text.endsWith(" -->\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(ok(text).blocks.map((b) => b.body)).toEqual(["", ""]);
  });

  it("is pure: same input, same output, no clock", () => {
    const model = ok(sample);
    expect(serializeConversation(model)).toBe(serializeConversation(structuredClone(model)));
  });

  it("parses optional time only when present; never synthesizes it", () => {
    const text = `${FRONT}\n<!-- cc:user id=${U1} -->\nq\n`;
    expect(ok(text).blocks[0]).not.toHaveProperty("time");
    expect(serializeConversation(ok(text))).not.toContain("time=");
  });
});

// ---------------------------------------------------------------------------
// Property-based tests

const uuid = fc.uuid({ version: 4 }).map((value) => value.toLowerCase());
const timestamp = fc
  .date({
    min: new Date("2000-01-01T00:00:00.000Z"),
    max: new Date("2100-01-01T00:00:00.000Z"),
    noInvalidDate: true,
  })
  .map((date) => date.toISOString());
const LINE_SEPARATORS = /[\n\r\u0085\u2028\u2029]/g;
const title = fc
  .string({ unit: "grapheme", minLength: 1, maxLength: 60 })
  .map((value) => value.replace(LINE_SEPARATORS, " "))
  .filter((value) => Array.from(value).length >= 1 && Array.from(value).length <= 200);
const opaque = fc.string({ maxLength: 30 });

/** Lines that stress the grammar: delimiter-like, backslashes, whitespace, CR. */
const trickyLine = fc.oneof(
  fc.string({ maxLength: 40 }).map((s) => s.replace(/\n/g, "")),
  fc.constantFrom(
    "<!-- cc:user id=x -->",
    "\\<!-- cc:assistant",
    "\\\\  <!--cc:",
    "  <!-- cc:system id=00000000-0000-4000-8000-000000000000 -->",
    "",
    "   ",
    "\t",
    "a\rb",
    "---",
    "trailing spaces   ",
  ),
);

/** A body in the valid model domain: LF only, no leading/trailing blank lines. */
const body = fc.array(trickyLine, { maxLength: 6 }).map((lines) => normalizeBody(lines.join("\n")));

const blocks: fc.Arbitrary<Block[]> = fc
  .array(
    fc.oneof(
      fc.record({ type: fc.constant("system" as const), body }),
      fc.record(
        {
          type: fc.constant("user" as const),
          body,
          time: timestamp,
          attachments: fc.array(uuid, { minLength: 1, maxLength: 10 }),
        },
        { requiredKeys: ["type", "body"] },
      ),
      fc.record(
        {
          type: fc.constant("assistant" as const),
          body,
          status: fc.constantFrom(
            "complete",
            "cancelled",
            "failed",
            "timed_out",
            "interrupted" as const,
          ),
          provider: opaque,
          model: opaque,
          time: timestamp,
          reasoning: body,
        },
        { requiredKeys: ["type", "body", "status"] },
      ),
    ),
    { maxLength: 8 },
  )
  .chain((items) =>
    fc.uniqueArray(uuid, { minLength: items.length, maxLength: items.length }).map((ids) =>
      items.flatMap((item, index): Block[] => {
        const id = ids[index] ?? "";
        if (item.type === "assistant") {
          const { reasoning, ...rest } = item;
          const assistant = { ...rest, id } as Block;
          return reasoning === undefined
            ? [assistant]
            : [{ type: "reasoning", id, body: reasoning }, assistant];
        }
        return [{ ...item, id }];
      }),
    ),
  );

const model: fc.Arbitrary<ConversationModel> = fc.record({
  title,
  createdAt: timestamp,
  updatedAt: timestamp,
  blocks,
});

describe("INV-09: round-trip properties (contracts §3.6)", () => {
  it("parse(serialize(x)) deep-equals x for every valid model", () => {
    fc.assert(
      fc.property(model, (m) => {
        const result = parseConversation(serializeConversation(m));
        expect(result).toEqual({ ok: true, conversation: m });
      }),
      { numRuns: 400 },
    );
  });

  it("serialize(parse(serialize(x))) === serialize(x)", () => {
    fc.assert(
      fc.property(model, (m) => {
        const once = serializeConversation(m);
        const parsed = parseConversation(once);
        if (!parsed.ok) throw new Error(parsed.reason);
        expect(serializeConversation(parsed.conversation)).toBe(once);
      }),
      { numRuns: 400 },
    );
  });

  it("external input with CRLF and blank edges normalizes into the round-trip domain", () => {
    fc.assert(
      fc.property(fc.array(trickyLine, { maxLength: 8 }), fc.boolean(), uuid, (lines, crlf, id) => {
        const raw = lines.join(crlf ? "\r\n" : "\n");
        const normalized = normalizeBody(raw);
        const m: ConversationModel = {
          title: "t",
          createdAt: T,
          updatedAt: T,
          blocks: [{ type: "user", id, body: normalized }],
        };
        const result = parseConversation(serializeConversation(m));
        expect(result).toEqual({ ok: true, conversation: m });
        expect(normalizeBody(normalized)).toBe(normalized);
      }),
      { numRuns: 400 },
    );
  });

  it("never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (text) => {
        const result = parseConversation(`${FRONT}\n${text}`);
        expect(typeof result.ok).toBe("boolean");
      }),
      { numRuns: 400 },
    );
  });
});
