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
    expect(config).toEqual({
      port: 3000,
      dataDir: root,
      nodeEnv: "development",
      logLevel: "info",
      listenHost: "127.0.0.1",
      inContainer: false,
      provider: {
        baseUrl: undefined,
        apiKey: undefined,
        timeoutMs: 300_000,
        generationMaxMs: 1_800_000,
        defaultContextTokens: 8_192,
        maxOutputTokens: 4_096,
        maxActiveGenerations: undefined,
        maxResponseBytes: 16 * 1024 * 1024,
      },
      storage: {
        localUserId: "5f0c6a3e-9d0b-4c1e-8f2a-3b6d7e8f9a01",
        operationRetentionMs: 7 * 86_400_000,
        contextTrimStep: undefined,
        templateOverheadTokens: 16,
      },
    });
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

  it("host mode refuses non-loopback listen addresses before authentication", () => {
    expect(() => loadConfig({ DATA_DIR: root, LISTEN_HOST: "0.0.0.0" })).toThrow(/loopback/);
    expect(() => loadConfig({ DATA_DIR: root, LISTEN_HOST: "192.168.1.10" })).toThrow(/loopback/);
    expect(loadConfig({ DATA_DIR: root, LISTEN_HOST: "::1" }).listenHost).toBe("::1");
  });

  it("the container image may listen on its own interface", () => {
    const config = loadConfig({ DATA_DIR: root, LISTEN_HOST: "0.0.0.0", CHATUI_CONTAINER: "1" });
    expect(config).toMatchObject({ listenHost: "0.0.0.0", inContainer: true });
  });

  it("rejects a LISTEN_HOST that is not an IP address", () => {
    expect(() => loadConfig({ DATA_DIR: root, LISTEN_HOST: "localhost" })).toThrow(/LISTEN_HOST/);
  });

  it("parses provider settings and strips a trailing slash from LLAMA_BASE_URL", () => {
    const config = loadConfig({
      DATA_DIR: root,
      LLAMA_BASE_URL: "http://192.168.1.20:8080/",
      LLAMA_API_KEY: "k",
      PROVIDER_TIMEOUT_MS: "60000",
      MAX_ACTIVE_GENERATIONS: "3",
    });
    expect(config.provider).toMatchObject({
      baseUrl: "http://192.168.1.20:8080",
      apiKey: "k",
      timeoutMs: 60_000,
      maxActiveGenerations: 3,
    });
  });

  it.each([
    "ftp://host/",
    "http://user:pass@host:8080",
    "http://host:8080/?key=secret",
    "not a url",
  ])("rejects LLAMA_BASE_URL=%s", (value) => {
    expect(() => loadConfig({ DATA_DIR: root, LLAMA_BASE_URL: value })).toThrow(/LLAMA_BASE_URL/);
  });

  it("never echoes a secret in configuration errors", () => {
    expect(() =>
      loadConfig({ DATA_DIR: root, LLAMA_API_KEY: "sk-very-secret", MAX_OUTPUT_TOKENS: "0" }),
    ).toThrow(
      expect.not.objectContaining({
        message: expect.stringContaining("sk-very-secret") as string,
      }) as Error,
    );
  });

  it("rejects a LOCAL_USER_ID that is not a canonical lowercase UUID", () => {
    for (const value of ["not-a-uuid", "5F0C6A3E-9D0B-4C1E-8F2A-3B6D7E8F9A01", "../etc"]) {
      expect(() => loadConfig({ DATA_DIR: root, LOCAL_USER_ID: value })).toThrow(/LOCAL_USER_ID/);
    }
  });

  it("treats empty values as unset", () => {
    expect(loadConfig({ PORT: "", DATA_DIR: root }).port).toBe(3000);
  });
});
