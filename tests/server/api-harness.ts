// A signed-in API client against a fresh instance, closed after each test.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach } from "vitest";
import type { ConversationSummary } from "@shared/conversations";
import type { ProjectDto } from "@shared/library";
import type { ChatUiApp } from "../../server/create-app.ts";
import { signIn, storageConfig, tempDataDir, testApp, type TestSession } from "./helpers.ts";

const servers: { server: Server; chatui: ChatUiApp }[] = [];
afterEach(async () => {
  for (const { server, chatui } of servers.splice(0)) {
    await chatui.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }
});

export async function startApi(role: "user" | "admin" = "user") {
  const { chatui } = testApp({ config: { dataDir: tempDataDir(), storage: storageConfig() } });
  await chatui.ready;
  const server = createServer(chatui.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({ server, chatui });
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const session: TestSession = await signIn(
    base,
    chatui,
    role === "admin" ? "root" : "alice",
    role,
  );
  const api = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: {
        ...session.headers(method !== "GET"),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Body };
  };
  return Object.assign(api, { base, session, chatui });
}

export interface Body {
  id: string;
  conversations: ConversationSummary[];
  projects: ProjectDto[];
  [key: string]: unknown;
}
