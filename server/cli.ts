/**
 * Stable container entrypoint (`node server/cli.ts <command>`). Runs natively
 * on Node via type stripping. Commands exist only once their underlying service
 * does; a command that is not available yet fails clearly instead of
 * pretending to succeed.
 */
import { ConfigError, loadConfig } from "./config.ts";

const PLANNED: Readonly<Record<string, string>> = {
  "user:create": "Phase 4 (initial admin creation via stdin)",
  "user:reset-password": "Phase 4",
  "index:rebuild": "Phase 3",
  backup: "Phase 16",
  restore: "Phase 16",
};

const USAGE = `Usage: node server/cli.ts <command>

Commands:
  serve         Start the HTTP server (default container command)
  healthcheck     Exit 0 if GET /api/health on this container answers {"status":"ok"}
  provider:check  Check that LLAMA_BASE_URL is reachable from here (DNS, routing,
                  credentials) and list how many models it reports

Planned (not available yet):
${Object.entries(PLANNED)
  .map(([name, phase]) => `  ${name.padEnd(13)} ${phase}`)
  .join("\n")}
`;

async function healthcheck(): Promise<number> {
  const port = process.env.PORT ?? "3000";
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(4_000),
    });
    const body = (await response.json()) as { status?: unknown };
    return response.ok && body.status === "ok" ? 0 : 1;
  } catch {
    return 1;
  }
}

/**
 * Connectivity check for the configured llama.cpp server, e.g. from inside the
 * container. Prints only status and counts: never the key or upstream bodies.
 */
async function providerCheck(): Promise<number> {
  let baseUrl: string | undefined;
  let apiKey: string | undefined;
  try {
    ({ baseUrl, apiKey } = loadConfig(process.env).provider);
  } catch (error) {
    process.stderr.write(
      `${error instanceof ConfigError ? error.message : "Invalid configuration"}\n`,
    );
    return 1;
  }
  if (!baseUrl) {
    process.stderr.write("LLAMA_BASE_URL is not set.\n");
    return 1;
  }
  const origin = new URL(baseUrl).origin;
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 || response.status === 403) {
      process.stderr.write(
        `${origin}: reachable, but the credentials were rejected (HTTP ${String(response.status)}).\n`,
      );
      return 1;
    }
    if (!response.ok) {
      process.stderr.write(
        `${origin}: reachable, but /v1/models returned HTTP ${String(response.status)}.\n`,
      );
      return 1;
    }
    const body = (await response.json()) as { data?: unknown };
    const count = Array.isArray(body.data) ? body.data.length : 0;
    process.stdout.write(`${origin}: OK, ${String(count)} model(s) reported.\n`);
    return 0;
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "TimeoutError" ? "timed out" : "unreachable";
    process.stderr.write(
      `${origin}: ${reason} (check DNS, routing and that the server listens beyond localhost).\n`,
    );
    return 1;
  }
}

const [command = "serve"] = process.argv.slice(2);

switch (command) {
  case "serve":
    await import("./main.ts");
    break;
  case "healthcheck":
    process.exitCode = await healthcheck();
    break;
  case "provider:check":
    process.exitCode = await providerCheck();
    break;
  case "help":
  case "--help":
  case "-h":
    process.stdout.write(USAGE);
    break;
  default: {
    const phase = PLANNED[command];
    process.stderr.write(
      phase
        ? `"${command}" is not available yet; it arrives in ${phase}.\n`
        : `Unknown command "${command}".\n\n${USAGE}`,
    );
    process.exitCode = 2;
  }
}
