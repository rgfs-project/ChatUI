/**
 * Stable container entrypoint (`node server/cli.ts <command>`). Runs natively
 * on Node via type stripping. Commands exist only once their underlying service
 * does; a command that is not available yet fails clearly instead of
 * pretending to succeed.
 */
import { ConfigError, loadConfig } from "./config.ts";
import { ChatIndex } from "./storage/chat-index.ts";
import { DataPaths } from "./storage/paths.ts";
import { PASSWORD_MAX, PASSWORD_MIN, PasswordHasher } from "./auth/passwords.ts";
import { createSafeFetch, SsrfError } from "./providers/ssrf.ts";
import { KeyedLocks } from "./storage/locks.ts";
import { accountIds } from "./storage/recovery.ts";
import { UserError, UserStore } from "./storage/users.ts";
import { SessionStore } from "./auth/sessions.ts";

const PLANNED: Readonly<Record<string, string>> = {
  backup: "Phase 16",
  restore: "Phase 16",
};

const USAGE = `Usage: node server/cli.ts <command>

Commands:
  serve         Start the HTTP server (default container command)
  healthcheck     Exit 0 if GET /api/health on this container answers {"status":"ok"}
  user:create --username <name> [--admin]
                  Create an account. The password is read from an interactive
                  prompt, or from stdin when piped (never from the command line)
  user:reset-password --username <name>
                  Set a new password (prompt or stdin, never the command line)
                  and sign the account out everywhere
  index:rebuild   Rebuild every derived conversation index from the canonical
                  Markdown in DATA_DIR (stop the server first: single process)
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
  let ssrf: ReturnType<typeof loadConfig>["provider"]["ssrf"];
  try {
    ({ baseUrl, apiKey, ssrf } = loadConfig(process.env).provider);
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
    // Same network policy as the server: resolved, checked, pinned, no redirects.
    const safeFetch = createSafeFetch(ssrf);
    const response = await safeFetch(`${baseUrl}/v1/models`, {
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
    if (error instanceof SsrfError) {
      process.stderr.write(
        `${origin}: refused by the provider network policy (${error.message}).\n`,
      );
      return 1;
    }
    const reason =
      error instanceof Error && error.name === "TimeoutError" ? "timed out" : "unreachable";
    process.stderr.write(
      `${origin}: ${reason} (check DNS, routing and that the server listens beyond localhost).\n`,
    );
    return 1;
  }
}

/** Reads a password without echo from a terminal, or all of stdin when piped. */
async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    let data = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) data += String(chunk);
    return data.replace(/\r?\n$/, "");
  }
  const ask = (prompt: string) =>
    new Promise<string>((resolve) => {
      process.stdout.write(prompt);
      const stdin = process.stdin;
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");
      let value = "";
      const onData = (key: string) => {
        for (const char of key) {
          if (char === "\r" || char === "\n") {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.off("data", onData);
            process.stdout.write("\n");
            resolve(value);
            return;
          }
          if (char === "\u0003") process.exit(130);
          if (char === "\u007f") value = value.slice(0, -1);
          else value += char;
        }
      };
      stdin.on("data", onData);
    });
  const first = await ask("Password: ");
  const second = await ask("Repeat password: ");
  if (first !== second) throw new Error("The passwords do not match.");
  return first;
}

async function userCreate(args: string[]): Promise<number> {
  if (args.some((arg) => arg.startsWith("--password"))) {
    process.stderr.write(
      "Passwords are never accepted as arguments; enter it at the prompt or pipe it on stdin.\n",
    );
    return 2;
  }
  const at = args.indexOf("--username");
  const username = at >= 0 ? args[at + 1] : undefined;
  const admin = args.includes("--admin");
  const known = new Set(["--username", "--admin", username]);
  if (!username || args.some((arg) => !known.has(arg))) {
    process.stderr.write("Usage: node server/cli.ts user:create --username <name> [--admin]\n");
    return 2;
  }
  let dataDir: string;
  try {
    ({ dataDir } = loadConfig(process.env));
  } catch (error) {
    process.stderr.write(
      `${error instanceof ConfigError ? error.message : "Invalid configuration"}\n`,
    );
    return 1;
  }
  let password: string;
  try {
    password = await readPassword();
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    process.stderr.write(
      `Passwords are ${String(PASSWORD_MIN)}-${String(PASSWORD_MAX)} characters.\n`,
    );
    return 1;
  }
  const paths = new DataPaths(dataDir);
  const users = new UserStore({ paths, locks: new KeyedLocks() });
  const passwordHash = await new PasswordHasher({ concurrency: 1, queue: 0 }).hash(password);
  try {
    const user = await users.create({ username, passwordHash, role: admin ? "admin" : "user" });
    process.stdout.write(`Created ${user.role} "${user.username}" (${user.id}).\n`);
    return 0;
  } catch (error) {
    if (error instanceof UserError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

/** Operator password reset: new hash, then every session of the account is revoked. */
async function userResetPassword(args: string[]): Promise<number> {
  if (args.some((arg) => arg.startsWith("--password"))) {
    process.stderr.write(
      "Passwords are never accepted as arguments; enter it at the prompt or pipe it on stdin.\n",
    );
    return 2;
  }
  const at = args.indexOf("--username");
  const username = at >= 0 ? args[at + 1] : undefined;
  if (!username || args.length !== 2) {
    process.stderr.write("Usage: node server/cli.ts user:reset-password --username <name>\n");
    return 2;
  }
  let dataDir: string;
  try {
    ({ dataDir } = loadConfig(process.env));
  } catch (error) {
    process.stderr.write(
      `${error instanceof ConfigError ? error.message : "Invalid configuration"}\n`,
    );
    return 1;
  }
  const paths = new DataPaths(dataDir);
  const users = new UserStore({ paths, locks: new KeyedLocks() });
  const user = await users.findByUsername(username);
  if (!user || user.status === "closing") {
    process.stderr.write(`No account "${username}".\n`);
    return 1;
  }
  let password: string;
  try {
    password = await readPassword();
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    process.stderr.write(
      `Passwords are ${String(PASSWORD_MIN)}-${String(PASSWORD_MAX)} characters.\n`,
    );
    return 1;
  }
  const passwordHash = await new PasswordHasher({ concurrency: 1, queue: 0 }).hash(password);
  await users.update(user.id, { passwordHash });
  // TTLs only matter for issuing/sweeping; revocation removes every record of the user.
  const revoked = await new SessionStore({ paths, absoluteTtlMs: 1, idleTtlMs: 1 }).revokeUser(
    user.id,
  );
  process.stdout.write(
    `Password reset for "${user.username}"; ${String(revoked)} session(s) signed out.\n`,
  );
  return 0;
}

/** Rebuilds derived indexes from canonical Markdown (contracts §1, INV-11). */
async function indexRebuild(): Promise<number> {
  let dataDir: string;
  try {
    ({ dataDir } = loadConfig(process.env));
  } catch (error) {
    process.stderr.write(
      `${error instanceof ConfigError ? error.message : "Invalid configuration"}\n`,
    );
    return 1;
  }
  const paths = new DataPaths(dataDir);
  const log = (level: string) => (obj: object, msg: string) => {
    process.stdout.write(`${JSON.stringify({ level, msg, ...obj })}\n`);
  };
  const index = new ChatIndex(paths, { info: log("info"), warn: log("warn") });
  const users = await accountIds(paths);
  for (const userId of users) {
    const entries = await index.rebuild(userId);
    process.stdout.write(`${userId}: ${String(entries.length)} conversation(s) indexed\n`);
  }
  if (users.length === 0) process.stdout.write("No user data found.\n");
  return 0;
}

const [command = "serve"] = process.argv.slice(2);

switch (command) {
  case "serve":
    await import("./main.ts");
    break;
  case "healthcheck":
    process.exitCode = await healthcheck();
    break;
  case "user:create":
    process.exitCode = await userCreate(process.argv.slice(3));
    break;
  case "user:reset-password":
    process.exitCode = await userResetPassword(process.argv.slice(3));
    break;
  case "index:rebuild":
    process.exitCode = await indexRebuild();
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
