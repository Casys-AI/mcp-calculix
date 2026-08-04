/** Stateless HTTP MCP server for deterministic CalculiX static solves. */

import { McpApp, type RegisterViewersSummary } from "@casys/mcp-server";
import { CalculixToolsClient } from "./src/client.ts";
import type { CalculixToolHandler } from "./src/tools/types.ts";

const VERSION = "0.5.0";
const DEFAULT_PORT = 3015;
const DEFAULT_HOSTNAME = "127.0.0.1";

export interface CreateCalculixServerOptions {
  /** Test seam for exercising the MCP wire without native solver binaries. */
  solveHandler?: CalculixToolHandler;
  logger?: (message: string) => void;
  viewerFileSystem?: CalculixResultsViewerFileSystem;
  viewerModuleUrl?: string;
}

export interface CalculixResultsViewerFileSystem {
  exists(path: string): boolean;
  readFile(path: string): string | Promise<string>;
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
  const viewerRegistration = registerCalculixResultsViewer(
    app,
    options.viewerFileSystem,
    options.viewerModuleUrl,
  );
  const hasResultsViewer = viewerRegistration.registered.includes(
    "results-viewer",
  );
  return { app, hasResultsViewer };
}

/** Register the optional built result viewer from a checkout or JSR package. */
export function registerCalculixResultsViewer(
  app: McpApp,
  fileSystem: CalculixResultsViewerFileSystem = defaultViewerFileSystem,
  moduleUrl: string = import.meta.url,
): RegisterViewersSummary {
  return app.registerViewers({
    prefix: "mcp-calculix",
    viewers: ["results-viewer"],
    moduleUrl,
    exists: fileSystem.exists,
    readFile: fileSystem.readFile,
    humanName: () => "CalculiX Static Results",
  });
}

/**
 * JSR resolves `import.meta.url` to HTTPS, while a source checkout resolves it
 * to a file path. The viewer is included in the package, so remote URLs are
 * eligible at registration time and fetched only when a client reads them.
 */
export function createCalculixResultsViewerFileSystem(
  fetchViewer: (url: string) => Promise<Response> = (url) => fetch(url),
): CalculixResultsViewerFileSystem {
  return {
    exists(path) {
      if (isRemoteViewerUrl(path)) return true;
      try {
        return Deno.statSync(path).isFile;
      } catch (error) {
        if (
          error instanceof Deno.errors.NotFound ||
          error instanceof Deno.errors.PermissionDenied ||
          (error instanceof Error && error.name === "NotCapable")
        ) {
          return false;
        }
        throw error;
      }
    },
    async readFile(path) {
      if (!isRemoteViewerUrl(path)) return await Deno.readTextFile(path);
      let response: Response;
      try {
        response = await fetchViewer(path);
      } catch (error) {
        throw new Error(
          `Unable to fetch CalculiX results viewer from ${path}.`,
          { cause: error },
        );
      }
      if (!response.ok) {
        throw new Error(
          `Unable to fetch CalculiX results viewer from ${path}: HTTP ${response.status} ${response.statusText}.`,
        );
      }
      return await response.text();
    },
  };
}

const defaultViewerFileSystem = createCalculixResultsViewerFileSystem();

if (import.meta.main) {
  const cli = parseCli(Deno.args);
  const { app, hasResultsViewer } = createCalculixServer();
  if (!hasResultsViewer) {
    console.error(
      "[mcp-calculix] Results viewer is not built; run `deno task build:ui`.",
    );
  }
  await app.startHttp({
    port: cli.port,
    hostname: cli.hostname,
    corsOrigins: ["http://127.0.0.1", "http://localhost"],
    onListen: ({ hostname, port }) => {
      console.error(
        `[mcp-calculix] Stateless MCP: http://${hostname}:${port}/mcp`,
      );
    },
  });
}

export interface CliOptions {
  port: number;
  hostname: string;
}

/** Parse the deliberately small stateless HTTP command surface. */
export function parseCli(args: readonly string[]): CliOptions {
  let port = integerEnv("MCP_PORT") ?? DEFAULT_PORT;
  let hostname = env("MCP_HOSTNAME") ?? DEFAULT_HOSTNAME;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument.startsWith("--port=")) {
      port = positivePort(argument.slice("--port=".length), "--port");
    } else if (argument === "--port") {
      port = positivePort(args[++index], "--port");
    } else if (argument.startsWith("--hostname=")) {
      hostname = nonEmpty(argument.slice("--hostname=".length), "--hostname");
    } else if (argument === "--hostname") {
      hostname = nonEmpty(args[++index], "--hostname");
    } else {
      throw new TypeError(`Unknown argument '${argument}'.`);
    }
  }
  return { port, hostname };
}

function positivePort(value: string | undefined, name: string): number {
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

function nonEmpty(value: string | undefined, name: string): string {
  if (!value || value.trim() === "") {
    throw new TypeError(`${name} must not be empty`);
  }
  return value;
}

function env(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

function isRemoteViewerUrl(path: string): boolean {
  try {
    const protocol = new URL(path).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
