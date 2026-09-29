import request from "supertest";
import { describe, expect, it } from "vitest";
import { cspDirectives } from "../../server/csp.ts";
import { testApp } from "./helpers.ts";

function scriptSrc(header: string): string {
  const directive = header.split(";").find((part) => part.trim().startsWith("script-src "));
  return directive ?? "";
}

describe("INV-57: Content-Security-Policy (contracts §9.2b)", () => {
  it("every response carries a fresh unpredictable script nonce", async () => {
    const { app } = testApp();
    const nonces = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const res = await request(app).get("/");
      const header = String(res.headers["content-security-policy"]);
      const match = /'nonce-([A-Za-z0-9+/=]+)'/.exec(scriptSrc(header));
      expect(match?.[1]).toBeDefined();
      expect(match?.[1]?.length).toBeGreaterThanOrEqual(22); // >= 128 bits base64
      nonces.add(match?.[1] ?? "");
    }
    expect(nonces.size).toBe(20);
  });

  it("the nonce is handed to the document handler for the same response", async () => {
    let seen: string | undefined;
    const { app } = testApp({
      createDocumentHandler: (getValues) => (_req, res) => {
        seen = getValues(res).nonce;
        res.type("text/html").send("ok");
      },
    });
    const res = await request(app).get("/");
    expect(res.headers["content-security-policy"]).toContain(`'nonce-${seen ?? "missing"}'`);
  });

  it("production policy has no unsafe-inline or unsafe-eval and locks down framing", () => {
    const directives = cspDirectives("production");
    const flat = Object.entries(directives)
      .map(([name, values]) => `${name} ${values.filter((v) => typeof v === "string").join(" ")}`)
      .join(";");
    expect(flat).not.toContain("unsafe-inline");
    expect(flat).not.toContain("unsafe-eval");
    expect(directives["object-src"]).toEqual(["'none'"]);
    expect(directives["base-uri"]).toEqual(["'none'"]);
    expect(directives["frame-ancestors"]).toEqual(["'none'"]);
  });

  it("test and production modes send the production policy", async () => {
    const { app } = testApp();
    const res = await request(app).get("/");
    const header = String(res.headers["content-security-policy"]);
    expect(header).not.toContain("unsafe-inline");
    expect(header).not.toContain("ws://");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });
});
