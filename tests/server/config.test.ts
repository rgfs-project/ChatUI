import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../server/config.ts";

let root: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "chatui-config-"));
  writeFileSync(path.join(root, "a-file"), "");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("configuration", () => {
  it("applies safe defaults", () => {
    const config = loadConfig({ DATA_DIR: root });
    expect(config).toEqual({ port: 3000, dataDir: root, nodeEnv: "development", logLevel: "info" });
  });

  it("resolves DATA_DIR relative to the working directory", () => {
    const config = loadConfig({ DATA_DIR: "." }, root);
    expect(config.dataDir).toBe(root);
  });

  it("accepts every documented value", () => {
    const config = loadConfig({
      PORT: "0",
      DATA_DIR: root,
      NODE_ENV: "production",
      LOG_LEVEL: "silent",
    });
    expect(config).toMatchObject({ port: 0, nodeEnv: "production", logLevel: "silent" });
  });

  it("fails fast listing every invalid variable", () => {
    let error: unknown;
    try {
      loadConfig({ PORT: "70000", NODE_ENV: "staging", LOG_LEVEL: "loud", DATA_DIR: root });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    expect(message).toContain("PORT");
    expect(message).toContain("NODE_ENV");
    expect(message).toContain("LOG_LEVEL");
  });

  it.each(["abc", "-1", "3.5", "1e3"])("rejects PORT=%s", (port) => {
    expect(() => loadConfig({ PORT: port, DATA_DIR: root })).toThrow(ConfigError);
  });

  it("rejects a DATA_DIR that does not exist or is not a directory", () => {
    expect(() => loadConfig({ DATA_DIR: path.join(root, "missing") })).toThrow(/DATA_DIR/);
    expect(() => loadConfig({ DATA_DIR: path.join(root, "a-file") })).toThrow(/DATA_DIR/);
  });

  it("treats empty values as unset", () => {
    expect(loadConfig({ PORT: "", DATA_DIR: root }).port).toBe(3000);
  });
});
