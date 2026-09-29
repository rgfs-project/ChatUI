/**
 * Process entry. Runs directly on Node 24 via type stripping (no build step for
 * this file), so it imports only native-loadable modules with .ts extensions.
 *
 * - production/test: loads the Vite SSR bundle (build/server/index.js) and
 *   serves prebuilt client assets from build/client.
 * - development: embeds Vite in middleware mode and reloads server/app.ts on change.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import express, { type Express } from "express";
import packageJson from "../package.json" with { type: "json" };
import { ConfigError, loadConfig, type Config } from "./config.ts";
import { createLogger, type Logger } from "./logger.ts";
import type * as AppModule from "./app.ts";

const SHUTDOWN_TIMEOUT_MS = 10_000;
const ROOT = path.resolve(import.meta.dirname, "..");

type AppModuleShape = typeof AppModule;

function appFrom(
  mod: AppModuleShape,
  config: Config,
  logger: Logger,
  clientDir?: string,
): ReturnType<AppModuleShape["createApp"]> {
  return mod.createApp({
    config,
    logger,
    version: packageJson.version,
    createDocumentHandler: mod.createDocumentHandlerFactory(config.nodeEnv),
    ...(clientDir ? { clientDir } : {}),
  });
}

interface Running {
  handler: Express;
  close: () => Promise<void>;
}

async function productionHandler(config: Config, logger: Logger): Promise<Running> {
  const bundle = pathToFileURL(path.join(ROOT, "build/server/index.js")).href;
  const mod = (await import(bundle)) as AppModuleShape;
  const app = appFrom(mod, config, logger, path.join(ROOT, "build/client"));
  return {
    handler: app.handler,
    close: () => {
      app.shutdown();
      return Promise.resolve();
    },
  };
}

async function developmentHandler(config: Config, logger: Logger): Promise<Running> {
  const vite = await import("vite");
  const devServer = await vite.createServer({
    root: ROOT,
    server: { middlewareMode: true },
    appType: "custom",
  });
  let cached: { mod: AppModuleShape; app: ReturnType<AppModuleShape["createApp"]> } | undefined;
  const outer = express();
  outer.disable("x-powered-by");
  outer.use(devServer.middlewares);
  outer.use(async (req, res, next) => {
    try {
      const mod = (await devServer.ssrLoadModule("./server/app.ts")) as AppModuleShape;
      if (cached?.mod !== mod) {
        cached?.app.shutdown();
        cached = { mod, app: appFrom(mod, config, logger) };
      }
      cached.app.handler(req, res, next);
    } catch (error) {
      if (error instanceof Error) devServer.ssrFixStacktrace(error);
      next(error);
    }
  });
  return {
    handler: outer,
    close: async () => {
      cached?.app.shutdown();
      await devServer.close();
    },
  };
}

function listen(server: Server, port: number, host: string): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server.address() as AddressInfo);
    });
  });
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
  const logger = createLogger(config.logLevel);

  const running =
    config.nodeEnv === "development"
      ? await developmentHandler(config, logger)
      : await productionHandler(config, logger);

  const server = createServer(running.handler);
  const address = await listen(server, config.port, config.listenHost);
  logger.info({ host: address.address, port: address.port, mode: config.nodeEnv }, "listening");

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    const force = setTimeout(() => {
      logger.warn("shutdown timeout; closing remaining connections");
      server.closeAllConnections();
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    // Ends generations and SSE observers first so long-lived streams do not hold
    // the server open.
    const closing = running.close();
    server.close(() => {
      void (async () => {
        await closing;
        clearTimeout(force);
        logger.info("shutdown complete");
        logger.flush();
        process.exitCode = 0;
      })();
    });
    server.closeIdleConnections();
  };
  process.once("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    shutdown("SIGINT");
  });
}

await main();
