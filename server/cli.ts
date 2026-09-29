/**
 * Stable container entrypoint (`node server/cli.ts <command>`). Runs natively
 * on Node via type stripping. Commands exist only once their underlying service
 * does; a command that is not available yet fails clearly instead of
 * pretending to succeed.
 */
export {};

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
  healthcheck   Exit 0 if GET /api/health on this container answers {"status":"ok"}

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

const [command = "serve"] = process.argv.slice(2);

switch (command) {
  case "serve":
    await import("./main.ts");
    break;
  case "healthcheck":
    process.exitCode = await healthcheck();
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
