/** Stateless HTTP MCP server for deterministic CalculiX static solves. */

import { McpApp } from "@casys/mcp-server";
import { CalculixToolsClient } from "./src/client.ts";
import { CALCULIX_RESULTS_VIEWER_URI } from "./src/tools/solve.ts";
import type { CalculixToolHandler } from "./src/tools/types.ts";

const VERSION = "0.2.0";
const DEFAULT_PORT = 3015;
const DEFAULT_HOSTNAME = "127.0.0.1";

export interface CreateCalculixServerOptions {
  /** Test seam for exercising the MCP wire without native solver binaries. */
  solveHandler?: CalculixToolHandler;
  logger?: (message: string) => void;
}

export function createCalculixServer(
  options: CreateCalculixServerOptions = {},
): { app: McpApp; hasResultsViewer: boolean } {
  const client = new CalculixToolsClient();
  const handlers = client.buildHandlersMap();
  if (options.solveHandler) {
    handlers.set("calculix_solve_static", options.solveHandler);
  }

  const app = new McpApp({
    name: "mcp-calculix",
    version: VERSION,
    transport: "stateless",
    maxConcurrent: 4,
    backpressureStrategy: "queue",
    validateSchema: true,
    instructions:
      "Deterministic finite-element static solves. Results report mesh and physical observations only; no requirement verdict is produced.",
    logger: options.logger ??
      ((message) => console.error(`[mcp-calculix] ${message}`)),
  });
  app.registerTools(client.toMCPFormat(), handlers);
  const hasResultsViewer = registerCalculixResultsViewer(app);
  return { app, hasResultsViewer };
}

export function registerCalculixResultsViewer(app: McpApp): boolean {
  const summary = app.registerViewers({
    prefix: "mcp-calculix",
    viewers: ["results-viewer"],
    moduleUrl: import.meta.url,
    exists: fileExists,
    readFile: Deno.readTextFile,
  });
  if (
    summary.registered.length > 0 &&
    !app.hasResource(CALCULIX_RESULTS_VIEWER_URI)
  ) {
    throw new Error(
      `CalculiX viewer registered under an unexpected URI; expected ${CALCULIX_RESULTS_VIEWER_URI}`,
    );
  }
  return summary.registered.length === 1;
}

if (import.meta.main) {
  const { app, hasResultsViewer } = createCalculixServer();
  if (!hasResultsViewer) {
    console.error(
      "[mcp-calculix] Results viewer is not built; run `deno task build:ui`.",
    );
  }
  await app.startHttp({
    port: portFrom(Deno.args) ?? integerEnv("MCP_PORT") ?? DEFAULT_PORT,
    hostname: hostnameFrom(Deno.args) ?? env("MCP_HOSTNAME") ??
      DEFAULT_HOSTNAME,
    corsOrigins: ["http://127.0.0.1", "http://localhost"],
    onListen: ({ hostname, port }) => {
      console.error(
        `[mcp-calculix] Stateless MCP: http://${hostname}:${port}/mcp`,
      );
    },
  });
}

function portFrom(args: readonly string[]): number | undefined {
  const value = option(args, "--port");
  return value === undefined ? undefined : positivePort(value, "--port");
}

function hostnameFrom(args: readonly string[]): string | undefined {
  const value = option(args, "--hostname");
  if (value !== undefined && value.trim() === "") {
    throw new TypeError("--hostname must not be empty");
  }
  return value;
}

function option(args: readonly string[], name: string): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === name) return args[index + 1];
    if (argument.startsWith(`${name}=`)) return argument.slice(name.length + 1);
  }
  return undefined;
}

function positivePort(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new TypeError(`${name} must be an integer between 1 and 65535`);
  }
  return parsed;
}

function integerEnv(name: string): number | undefined {
  const value = env(name);
  return value === undefined ? undefined : positivePort(value, name);
}

function env(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

function fileExists(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}
