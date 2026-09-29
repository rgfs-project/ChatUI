import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { startMockLlama } from "../support/mock-llama.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
export const E2E_USER = "e2e";
export const E2E_PASSWORD = "e2e password 1234";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/** Starts the production server against a paced mock provider; returns the teardown. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "chatui-e2e-"));
  const llama = await startMockLlama({ chatChunkDelayMs: 30, chunkDelayMs: 120, slowChunks: 30 });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["server/cli.ts", "user:create", "--username", E2E_USER],
      {
        cwd: ROOT,
        env: { ...process.env, DATA_DIR: dataDir },
        stdio: ["pipe", "ignore", "inherit"],
      },
    );
    child.stdin.end(`${E2E_PASSWORD}\n`);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`user:create failed (${String(code)})`));
    });
  });
  const port = await freePort();
  const base = `http://127.0.0.1:${String(port)}`;
  const server = spawn(process.execPath, ["server/main.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      PUBLIC_ORIGIN: base,
      DATA_DIR: dataDir,
      LLAMA_BASE_URL: llama.url,
      LOG_LEVEL: "warn",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("server did not start"));
    }, 20_000);
    server.once("exit", (code) => {
      reject(new Error(`server exited (${String(code)})`));
    });
    createInterface({ input: server.stdout }).on("line", () => undefined);
    const poll = setInterval(() => {
      fetch(`${base}/api/health`).then(
        (res) => {
          if (res.ok) {
            clearInterval(poll);
            clearTimeout(timer);
            server.removeAllListeners("exit");
            resolve();
          }
        },
        () => undefined,
      );
    }, 200);
  });
  process.env.E2E_BASE_URL = base;
  process.env.E2E_DATA_DIR = dataDir;
  return async () => {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await exited;
    await llama.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
}
