/**
 * Stable container entrypoint (`node server/cli.ts <command>`). Runs natively
 * on Node via type stripping. Commands exist only once their underlying service
 * does; a command that is not available yet fails clearly instead of
 * pretending to succeed.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import packageJson from "../package.json" with { type: "json" };
import { assertOffline, BackupError, createBackup, restoreBackup } from "./backup.ts";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import { createLogger } from "./logger.ts";
import { ChatIndex } from "./storage/chat-index.ts";
import { DataPaths } from "./storage/paths.ts";
import { PASSWORD_MAX, PASSWORD_MIN, PasswordHasher } from "./auth/passwords.ts";
import { createSafeFetch, SsrfError } from "./providers/ssrf.ts";
import { KeyedLocks } from "./storage/locks.ts";
import { accountIds } from "./storage/recovery.ts";
import { UserError, UserStore } from "./storage/users.ts";
import { SessionStore } from "./auth/sessions.ts";

const PLANNED: Readonly<Record<string, string>> = {};

const USAGE = `Usage: node server/cli.ts <command>

Commands:
  serve         Start the HTTP server (default container command)
  healthcheck     Exit 0 if GET /api/health on this container answers {"status":"ok"}
  user:create --username <name> [--admin]
                  Create an account. The password is read from an interactive
                  prompt, or from stdin when piped (never from the command line)
  user:reset-password --username <name>
                  Set a new password (prompt or stdin, never the command line)
                  and sign that account out everywhere
  index:rebuild   Rebuild every derived conversation index from the canonical
                  Markdown in DATA_DIR (stop the server first: single process)
  provider:check  Check that LLAMA_BASE_URL is reachable from here (DNS, routing,
                  credentials) and list how many models it reports
  backup --out <dir> [--with-sessions]
                  Stop the server first. Runs startup recovery, then copies
                  DATA_DIR (without derived indexes, import staging and, unless
                  asked, sessions) into a new directory with a checksum manifest.
                  The backup holds user content and secrets: store it safely
  restore --from <dir>
                  Stop the server first. Verifies every checksum, refuses
                  unknown files, copies the backup into an EMPTY DATA_DIR, then
                  runs startup recovery once to check that it starts
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

/** Operator password reset: revokes every session of the account (INV-17). */
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
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    process.stderr.write(
      `${error instanceof ConfigError ? error.message : "Invalid configuration"}\n`,
    );
    return 1;
  }
  const paths = new DataPaths(config.dataDir);
  const users = new UserStore({ paths, locks: new KeyedLocks() });
  const user = await users.findByUsername(username);
  if (!user || user.status === "closing") {
    process.stderr.write(`No account named "${username}".\n`);
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
  const sessions = new SessionStore({
    paths,
    absoluteTtlMs: config.auth.sessionAbsoluteTtlMs,
    idleTtlMs: config.auth.sessionIdleTtlMs,
  });
  const revoked = await sessions.revokeUser(user.id);
  process.stdout.write(
    `Password changed for "${user.username}"; ${String(revoked)} session(s) signed out.\n`,
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

/** Startup recovery exactly as the server runs it (contracts §2), then a clean stop. */
async function recoveryPass(config: Config): Promise<void> {
  const bundle = path.resolve(import.meta.dirname, "..", "build/server/index.js");
  let mod: {
    createApp: (options: unknown) => { ready: Promise<void>; shutdown: () => Promise<void> };
  };
  try {
    mod = (await import(pathToFileURL(bundle).href)) as typeof mod;
  } catch {
    throw new BackupError("The server build is missing (run `npm run build` first)");
  }
  const app = mod.createApp({
    config,
    logger: createLogger("warn"),
    version: packageJson.version,
    createDocumentHandler:
      () => (_req: unknown, res: { status: (n: number) => { end: () => void } }) => {
        res.status(503).end();
      },
  });
  await app.ready;
  await app.shutdown();
}

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

async function backup(args: string[]): Promise<number> {
  const out = flag(args, "--out");
  const known = new Set(["--out", "--with-sessions", out]);
  if (!out || args.some((arg) => !known.has(arg))) {
    process.stderr.write("Usage: node server/cli.ts backup --out <dir> [--with-sessions]\n");
    return 2;
  }
  try {
    const config = loadConfig(process.env);
    await assertOffline(config.dataDir);
    await recoveryPass(config);
    const done = await createBackup({
      dataDir: config.dataDir,
      out,
      includeSessions: args.includes("--with-sessions"),
      chatuiVersion: packageJson.version,
    });
    process.stdout.write(
      `Backed up ${String(done.files)} file(s), ${String(done.bytes)} bytes, to ${path.resolve(out)}.\n` +
        "It contains user content and secrets (providers.json): keep it as safe as DATA_DIR.\n",
    );
    return 0;
  } catch (error) {
    process.stderr.write(`${backupMessage(error)}\n`);
    return 1;
  }
}

async function restore(args: string[]): Promise<number> {
  const from = flag(args, "--from");
  const known = new Set(["--from", from]);
  if (!from || args.some((arg) => !known.has(arg))) {
    process.stderr.write("Usage: node server/cli.ts restore --from <dir>\n");
    return 2;
  }
  try {
    // A fresh DATA_DIR may not exist yet; configuration requires the directory.
    // An empty DATA_DIR means unset, as in loadConfig.
    const raw = process.env.DATA_DIR;
    await mkdir(path.resolve(raw === undefined || raw === "" ? "./data" : raw), {
      recursive: true,
      mode: 0o700,
    });
    const config = loadConfig(process.env);
    await assertOffline(config.dataDir);
    const done = await restoreBackup({ from, dataDir: config.dataDir });
    await recoveryPass(config);
    process.stdout.write(
      `Restored ${String(done.files)} file(s) into ${path.resolve(config.dataDir)}; startup recovery completed.\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(`${backupMessage(error)}\n`);
    return 1;
  }
}

function backupMessage(error: unknown): string {
  if (error instanceof ConfigError || error instanceof BackupError) return error.message;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code ? `Failed: ${code}` : "Failed";
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
  case "backup":
    process.exitCode = await backup(process.argv.slice(3));
    break;
  case "restore":
    process.exitCode = await restore(process.argv.slice(3));
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
