import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { base, hydrated, longChat, signIn } from "./helpers.ts";

/**
 * Measurement audit (rebuild plan §1 #4): computed sizes and colours of the
 * shell compared with the reference values, in light and dark, so the visual
 * language cannot drift between phases.
 */
interface BoxSpec {
  name: string;
  selector: string;
  width?: number;
  height?: number;
  css?: Record<string, string>;
}
interface Spec {
  boxes: BoxSpec[];
  draftBoxes: BoxSpec[];
  menu: BoxSpec[];
  dialog: BoxSpec[];
  colors: Record<"light" | "dark", Record<string, Record<string, string>>>;
  fontStackStartsWith: string;
}
const spec = JSON.parse(
  readFileSync(new URL("./measurements.json", import.meta.url), "utf8"),
) as Spec;

async function measure(page: Page, specs: BoxSpec[]): Promise<string[]> {
  return page.evaluate((list) => {
    const problems: string[] = [];
    for (const s of list) {
      const el = document.querySelector(s.selector);
      if (!el) {
        problems.push(`${s.name}: ${s.selector} not found`);
        continue;
      }
      const box = el.getBoundingClientRect();
      if (s.width !== undefined && Math.abs(box.width - s.width) > 0.5)
        problems.push(`${s.name}: width ${String(box.width)} ≠ ${String(s.width)}`);
      if (s.height !== undefined && Math.abs(box.height - s.height) > 0.5)
        problems.push(`${s.name}: height ${String(box.height)} ≠ ${String(s.height)}`);
      const style = getComputedStyle(el);
      for (const [prop, want] of Object.entries(s.css ?? {})) {
        const got = style.getPropertyValue(prop);
        if (got !== want) problems.push(`${s.name}: ${prop} "${got}" ≠ "${want}"`);
      }
    }
    return problems;
  }, specs);
}

async function colours(page: Page, scheme: "light" | "dark"): Promise<string[]> {
  return page.evaluate((table) => {
    const problems: string[] = [];
    for (const [selector, props] of Object.entries(table)) {
      const el = document.querySelector(selector);
      if (!el) {
        problems.push(`${selector} not found`);
        continue;
      }
      const style = getComputedStyle(el);
      for (const [prop, want] of Object.entries(props)) {
        const got = style.getPropertyValue(prop);
        if (got !== want) problems.push(`${selector}: ${prop} "${got}" ≠ "${want}"`);
      }
    }
    return problems;
  }, spec.colors[scheme]);
}

test.use({ viewport: { width: 1920, height: 1080 } });

for (const scheme of ["light", "dark"] as const) {
  test(`measurement audit (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await signIn(page);
    const problems: string[] = [];
    // Draft screen.
    problems.push(...(await measure(page, spec.draftBoxes)));
    // A conversation with every element present.
    await page.goto(`${base()}/chat/${longChat()}`);
    await hydrated(page);
    await page.locator(".msg-user").last().hover();
    problems.push(...(await measure(page, spec.boxes)));
    problems.push(...(await colours(page, scheme)));
    const font = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    if (!font.startsWith(spec.fontStackStartsWith)) problems.push(`font stack "${font}"`);
    await page.getByTestId("model-picker").click();
    problems.push(...(await measure(page, spec.menu)));
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Chat options" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    problems.push(...(await measure(page, spec.dialog)));
    await page.keyboard.press("Escape");
    expect(problems).toEqual([]);
  });
}
