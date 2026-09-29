import request from "supertest";
import { describe, expect, it } from "vitest";
import { captureLogger, testApp } from "./helpers.ts";

describe("structured logging", () => {
  it("redacts secret-like fields at the top level and one level down", () => {
    const { logger, lines } = captureLogger();
    logger.info(
      {
        password: "hunter2",
        token: "tok-123",
        apiKey: "key-abc",
        nested: { secret: "s3cr3t", cookie: "sid=1", authorization: "Bearer zzz", keep: "visible" },
      },
      "event",
    );
    const text = JSON.stringify(lines());
    for (const secret of ["hunter2", "tok-123", "key-abc", "s3cr3t", "sid=1", "Bearer zzz"]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("visible");
    expect(text).toContain("[REDACTED]");
  });

  it("request logs omit headers, cookies and query strings", async () => {
    const { app, logs } = testApp();
    await request(app)
      .get("/api/health?token=abc123")
      .set("Cookie", "session=very-secret")
      .set("Authorization", "Bearer also-secret");
    const text = JSON.stringify(logs.lines());
    expect(text).toContain("/api/health");
    expect(text).not.toContain("very-secret");
    expect(text).not.toContain("also-secret");
    expect(text).not.toContain("abc123");
  });
});
