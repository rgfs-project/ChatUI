// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Markdown } from "../../app/chat/markdown";
import { highlighterModule } from "../../app/chat/render/code";
import { UiBlocksContext } from "../../app/chat/ui/context";
import { parseUiBlock, UI_LIMITS } from "../../app/chat/ui/parse";
import { thoughtLabel } from "../../app/chat/message";

beforeAll(async () => {
  await highlighterModule.load();
  await import("../../app/chat/ui/blocks");
});

afterEach(() => {
  cleanup();
});

const SAMPLE = [
  "callout tip Drink water before you run.",
  "card Morning plan",
  "  text Start slow.",
  "  steps",
  "    - Warm up",
  "    - Run 3 km",
  "stats",
  "  stat Distance = 5 km",
  "  stat Pace = 6:10 /km | steady",
  "chart bar Weekly kilometres",
  "  Mon = 5",
  "  Wed = 8",
  "quiz Which muscle does a squat work most?",
  "  option Biceps",
  "  option* Quadriceps",
  "  explain Squats load the quadriceps.",
  "tabs",
  "  tab Beginner",
  "    text Three runs a week.",
  "  tab Advanced",
  "    text Five runs a week.",
  "progress Training block = 40",
  "divider",
].join("\n");

async function show(source: string, enabled = true, streaming = false) {
  const view = render(
    <UiBlocksContext.Provider value={{ enabled, streaming }}>
      <Markdown>{source}</Markdown>
    </UiBlocksContext.Provider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  return view.container;
}

describe("UI block parser (docs/threat-model-14b.md)", () => {
  it("reads every statement into allowlisted nodes", () => {
    const parsed = parseUiBlock(SAMPLE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.nodes.map((n) => n.type)).toEqual([
      "callout",
      "card",
      "stats",
      "chart",
      "quiz",
      "tabs",
      "progress",
      "divider",
    ]);
    expect(parsed.nodes[0]).toEqual({
      type: "callout",
      tone: "tip",
      text: "Drink water before you run.",
    });
    expect(parsed.nodes[2]).toMatchObject({
      stats: [
        { label: "Distance", value: "5 km", note: null },
        { label: "Pace", value: "6:10 /km", note: "steady" },
      ],
    });
    expect(parsed.nodes[4]).toMatchObject({
      options: [
        { text: "Biceps", correct: false },
        { text: "Quadriceps", correct: true },
      ],
    });
  });

  it("reads the JSON form into the same nodes; prototype keys mean nothing", () => {
    const parsed = parseUiBlock(
      JSON.stringify([
        { type: "card", title: "T", children: [{ type: "text", text: "x" }] },
        {
          type: "chart",
          kind: "line",
          title: "c",
          points: [
            { label: "a", value: 1 },
            { label: "b", value: "2" },
          ],
        },
        JSON.parse(
          '{"type":"callout","tone":"evil","text":"t","__proto__":{"polluted":true}}',
        ) as unknown,
      ]),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.nodes[1]).toMatchObject({ points: [{ label: "a", value: 1 }] });
    expect(parsed.nodes[2]).toEqual({ type: "callout", tone: "info", text: "t" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("refuses unknown statements and everything over a bound", () => {
    expect(parseUiBlock("script alert(1)").ok).toBe(false);
    expect(parseUiBlock("x".repeat(UI_LIMITS.source + 1)).ok).toBe(false);
    const deep = [
      "card a",
      "  card b",
      "    card c",
      "      card d",
      "        card e",
      "          text deep",
    ].join("\n");
    expect(parseUiBlock(deep).ok).toBe(false);
    expect(parseUiBlock(Array.from({ length: 400 }, () => "divider").join("\n")).ok).toBe(false);
    expect(
      parseUiBlock(
        ["chart bar c", ...Array.from({ length: 50 }, (_, i) => `  p${String(i)} = 1`)].join("\n"),
      ).ok,
    ).toBe(false);
    expect(parseUiBlock(`text ${"y".repeat(5000)}`)).toMatchObject({
      ok: true,
      nodes: [{ text: "y".repeat(UI_LIMITS.text) }],
    });
    // Numbers are clamped and only plain decimals count.
    expect(parseUiBlock("progress p = 1e300")).toMatchObject({ ok: true, nodes: [{ value: 0 }] });
    expect(parseUiBlock("progress p = 250")).toMatchObject({ ok: true, nodes: [{ value: 100 }] });
  });

  it("while streaming, only finished lines count and half-written JSON is not ready", () => {
    expect(parseUiBlock("callout tip Done.\ncallout warn", false)).toMatchObject({
      ok: true,
      nodes: [{ type: "callout", text: "Done." }],
    });
    expect(parseUiBlock('{"type": "card", "ti', false).ok).toBe(false);
  });

  it("labels the reasoning with how long it took", () => {
    expect(thoughtLabel(null)).toBe("Thought");
    expect(thoughtLabel(400)).toBe("Thought for a moment");
    expect(thoughtLabel(12_300)).toBe("Thought for 12s");
    expect(thoughtLabel(125_000)).toBe("Thought for 2m 5s");
  });
});

describe("UI block rendering", () => {
  it("renders a block with text nodes only; markup in it stays text", async () => {
    const container = await show(
      "Here:\n\n```ui\ncallout warning <img src=x onerror=alert(1)><script>alert(2)</script>\ntext javascript:alert(3)\n```",
    );
    const block = screen.getByTestId("ui-block");
    expect(block.textContent).toContain("<script>alert(2)</script>");
    expect(container.querySelector("script, img, a, iframe, form, input[type=text]")).toBeNull();
    expect(block.querySelector("[style]")).toBeNull();
  });

  it("tabs switch with the arrow keys and the quiz checks an answer", async () => {
    await show(`\`\`\`ui\n${SAMPLE}\n\`\`\``);
    const tabs = screen.getAllByRole("tab");
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    tabs[0]?.focus();
    fireEvent.keyDown(tabs[0] as HTMLElement, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Advanced" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByRole("tabpanel").textContent).toBe("Five runs a week.");
    fireEvent.click(screen.getByRole("radio", { name: "Quadriceps" }));
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(screen.getByRole("status").textContent).toBe("Correct. Squats load the quadriceps.");
    // The chart's numbers are also in an accessible table.
    expect(screen.getByRole("img", { name: "Weekly kilometres" })).toBeTruthy();
    expect(screen.getByRole("rowheader", { name: "Wed" })).toBeTruthy();
  });

  it("shows the source as code when the setting is off or the block can't be read", async () => {
    await show("```ui\ncallout tip Hi\n```", false);
    expect(screen.queryByTestId("ui-block")).toBeNull();
    expect(document.body.textContent).toContain("callout tip Hi");
    cleanup();
    await show("```ui\nnonsense here\n```");
    expect(screen.queryByTestId("ui-block")).toBeNull();
    expect(document.body.textContent).toContain("nonsense here");
  });
});
