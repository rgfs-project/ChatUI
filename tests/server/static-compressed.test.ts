import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync, brotliCompressSync } from "node:zlib";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { acceptedEncodings, precompressedAssets } from "../../server/static-compressed.ts";

function app() {
  const dir = mkdtempSync(path.join(tmpdir(), "chatui-assets-"));
  const js = Buffer.from("console.log('x');".repeat(200));
  writeFileSync(path.join(dir, "app-abc123.js"), js);
  writeFileSync(path.join(dir, "app-abc123.js.br"), brotliCompressSync(js));
  writeFileSync(path.join(dir, "app-abc123.js.gz"), gzipSync(js));
  writeFileSync(path.join(dir, "small-def456.css"), "a{}");
  const server = express();
  server.use("/assets", precompressedAssets(dir));
  server.use("/assets", express.static(dir, { immutable: true, maxAge: "1y" }));
  return { server, js };
}

describe("precompressed hashed assets (Phase 9)", () => {
  it("serves Brotli when accepted, with the original type, Vary and immutable caching", async () => {
    const { server, js } = app();
    const res = await request(server)
      .get("/assets/app-abc123.js")
      .set("Accept-Encoding", "gzip, deflate, br, zstd");
    expect(res.headers["content-encoding"]).toBe("br");
    expect(res.headers["content-type"]).toMatch(/javascript/);
    expect(res.headers.vary).toMatch(/Accept-Encoding/);
    expect(res.headers["cache-control"]).toContain("immutable");
    // The wire size is the compressed file (the client decodes it).
    expect(Number(res.headers["content-length"])).toBeLessThan(js.length / 5);
  });

  it("falls back to gzip, honours q=0, and serves identity when nothing is accepted", async () => {
    const { server } = app();
    const gz = await request(server).get("/assets/app-abc123.js").set("Accept-Encoding", "gzip");
    expect(gz.headers["content-encoding"]).toBe("gzip");
    const refused = await request(server)
      .get("/assets/app-abc123.js")
      .set("Accept-Encoding", "br;q=0, gzip");
    expect(refused.headers["content-encoding"]).toBe("gzip");
    const plain = await request(server)
      .get("/assets/app-abc123.js")
      .set("Accept-Encoding", "identity");
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(plain.headers.vary).toMatch(/Accept-Encoding/);
  });

  it("files without a variant and odd paths fall through to the static server", async () => {
    const { server } = app();
    const small = await request(server)
      .get("/assets/small-def456.css")
      .set("Accept-Encoding", "br");
    expect(small.status).toBe(200);
    expect(small.headers["content-encoding"]).toBeUndefined();
    const traversal = await request(server)
      .get("/assets/..%2Fetc%2Fpasswd")
      .set("Accept-Encoding", "br");
    expect(traversal.headers["content-encoding"]).toBeUndefined();
    expect(traversal.status).toBe(404);
  });

  it("parses Accept-Encoding quality values", () => {
    expect([...acceptedEncodings("gzip, br;q=0.8, zstd;q=0")]).toEqual(["gzip", "br"]);
    expect(acceptedEncodings(undefined).size).toBe(0);
  });
});
