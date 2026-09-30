import { describe, expect, it } from "vitest";
import { safeReturnTo } from "../../app/lib/api";
import { documentPathOf, paths } from "../../app/lib/paths";

describe("INV-53: path builders", () => {
  it("encodes opaque conversation ids", () => {
    expect(paths.chat("a/b?c")).toBe("/chat/a%2Fb%3Fc");
    expect(paths.login("/chat/x")).toBe("/login?returnTo=%2Fchat%2Fx");
  });

  it("a loader's return-to names the page, not the single-fetch data endpoint", () => {
    const id = "7e0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
    expect(documentPathOf(`http://h/chat/${id}.data?_routes=routes%2Fapp-layout`)).toBe(
      `/chat/${id}`,
    );
    expect(documentPathOf("http://h/chat/new.data")).toBe("/chat/new");
    expect(documentPathOf("http://h/_root.data")).toBe("/");
    expect(documentPathOf("http://h/settings?tab=a&_routes=x")).toBe("/settings?tab=a");
    expect(documentPathOf("http://h/chat/new")).toBe("/chat/new");
    // Round trip through the login page's validation.
    expect(safeReturnTo(documentPathOf(`http://h/chat/${id}.data`))).toBe(`/chat/${id}`);
  });
});
