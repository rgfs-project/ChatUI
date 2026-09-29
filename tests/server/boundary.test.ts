import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testApp } from "./helpers.ts";

let clientDir: string;

beforeAll(() => {
  clientDir = mkdtempSync(path.join(tmpdir(), "chatui-client-"));
  mkdirSync(path.join(clientDir, "assets"));
  writeFileSync(path.join(clientDir, "assets", "entry-abc123.js"), "export {};\n");
  writeFileSync(path.join(clientDir, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
});

afterAll(() => {
  rmSync(clientDir, { recursive: true, force: true });
});

describe("INV-57: API / asset / document boundary", () => {
  it("hashed assets are served with immutable long-lived caching", async () => {
    const { app } = testApp({ clientDir });
    const res = await request(app).get("/assets/entry-abc123.js");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toMatch(/immutable/);
    expect(res.headers["cache-control"]).toMatch(/max-age=31536000/);
  });

  it("missing assets are a non-HTML 404 and never reach the document handler", async () => {
    const { app } = testApp({ clientDir });
    for (const url of ["/assets/missing.js", "/assets/", "/assets/../package.json"]) {
      const res = await request(app).get(url);
      expect(res.status, url).toBe(404);
      expect(res.headers["content-type"], url).not.toMatch(/text\/html/);
      expect(res.text, url).not.toContain("document");
    }
  });

  it("asset 404s are non-HTML even without a client build (development)", async () => {
    const { app } = testApp();
    const res = await request(app).get("/assets/app.css");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
  });

  it("API requests never fall through to the document handler", async () => {
    const { app } = testApp({ clientDir });
    const res = await request(app).post("/api/whatever").send({ a: 1 });
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.text).not.toContain("document");
  });

  it("other paths are handled by the document handler", async () => {
    const { app } = testApp({ clientDir });
    const res = await request(app).get("/some/page");
    expect(res.status).toBe(200);
    expect(res.text).toContain("document");
  });

  it("root static files are served but directories never produce listings", async () => {
    const { app } = testApp({ clientDir });
    const icon = await request(app).get("/favicon.svg");
    expect(icon.status).toBe(200);
    expect(icon.headers["cache-control"]).not.toMatch(/immutable/);
  });

  it("does not advertise the server framework", async () => {
    const { app } = testApp();
    const res = await request(app).get("/api/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});
