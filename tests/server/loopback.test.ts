import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { isLoopbackAddress } from "../../server/loopback.ts";
import { testApp } from "./helpers.ts";

/** A non-loopback IPv4 address of this machine, so a test can be a non-loopback peer. */
const externalIPv4 = Object.values(networkInterfaces())
  .flat()
  .find((iface) => iface?.family === "IPv4" && !iface.internal)?.address;

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server)
      server.close(() => {
        resolve();
      });
    else resolve();
  });
  server = undefined;
});

async function serve(inContainer: boolean): Promise<number> {
  const { app } = testApp({ config: { nodeEnv: "test", inContainer } });
  server = createServer(app);
  // Test-only: listen on all interfaces so a non-loopback peer can connect.
  await new Promise<void>((resolve) => server?.listen(0, "0.0.0.0", resolve));
  return (server.address() as AddressInfo).port;
}

function get(host: string, port: number, headers: Record<string, string> = {}) {
  return new Promise<{ status: number } | { error: string }>((resolve) => {
    const req = httpRequest({ host, port, path: "/api/health", headers }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
    });
    req.on("error", (error: NodeJS.ErrnoException) => {
      resolve({ error: error.code ?? error.message });
    });
    req.end();
  });
}

describe("pre-auth loopback boundary (contracts §9.2b)", () => {
  it.each(["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1", "::FFFF:127.1.2.3"])(
    "%s is loopback",
    (address) => {
      expect(isLoopbackAddress(address)).toBe(true);
    },
  );

  it.each([
    undefined,
    "",
    "10.0.0.5",
    "192.168.1.2",
    "::ffff:10.0.0.1",
    "fe80::1",
    "::",
    "0.0.0.0",
    "128.0.0.1",
    "localhost",
  ])("%s is not loopback", (address) => {
    expect(isLoopbackAddress(address)).toBe(false);
  });

  it("host mode serves loopback peers", async () => {
    const port = await serve(false);
    expect(await get("127.0.0.1", port)).toEqual({ status: 200 });
  });

  it.skipIf(!externalIPv4)(
    "host mode drops non-loopback peers even when forwarded headers claim loopback",
    async () => {
      const port = await serve(false);
      const result = await get(externalIPv4 ?? "", port, {
        "X-Forwarded-For": "127.0.0.1",
        "X-Real-IP": "127.0.0.1",
      });
      expect(result).toEqual({ error: "ECONNRESET" });
    },
  );

  it.skipIf(!externalIPv4)(
    "container mode serves non-loopback peers (Compose publishes on 127.0.0.1)",
    async () => {
      const port = await serve(true);
      expect(await get(externalIPv4 ?? "", port)).toEqual({ status: 200 });
    },
  );
});
