/** MCP server for bounded deterministic CalculiX analyses. */

import {
  McpApp,
  type MCPResource,
  type RegisterViewersSummary,
  type ResourceHandler,
} from "@casys/mcp-server";
import { CalculixToolsClient } from "./src/client.ts";
import { CalculixRunStore, type RecordedStaticRun } from "./src/runs.ts";
import type { CalculixToolHandler } from "./src/tools/types.ts";

const VERSION = "0.8.1";
const DEFAULT_PORT = 3015;
const DEFAULT_HOSTNAME = "127.0.0.1";

export interface CreateCalculixServerOptions {
  /** Test seam for exercising the MCP wire without native solver binaries. */
  solveHandler?: CalculixToolHandler;
  /** Test seam for exercising mesh preflight MCP wiring without Gmsh. */
  meshPreflightHandler?: CalculixToolHandler;
  logger?: (message: string) => void;
  viewerFileSystem?: CalculixResultsViewerFileSystem;
  viewerModuleUrl?: string;
  /** Durable, bounded evidence directory for recorded static solves. */
  runsDirectory?: string;
  maxRecordedRuns?: number;
  /** Advanced integration seam; production normally configures the directory. */
  runStore?: CalculixRunStore;
}

export interface CalculixResultsViewerFileSystem {
  exists(path: string): boolean;
  readFile(path: string): string | Promise<string>;
}

export function createCalculixServer(
  options: CreateCalculixServerOptions = {},
): {
  app: McpApp;
  hasResultsViewer: boolean;
  runStore: CalculixRunStore;
  toolsClient: CalculixToolsClient;
} {
  const runStore = options.runStore ?? new CalculixRunStore({
    runsDirectory: options.runsDirectory ?? env("CALCULIX_RUNS_DIRECTORY"),
    maxRuns: options.maxRecordedRuns ?? positiveIntegerEnv(
      "CALCULIX_MAX_RECORDED_RUNS",
    ),
  });
  const toolsClient = new CalculixToolsClient({ runStore });
  const handlers = toolsClient.buildHandlersMap();
  if (options.solveHandler) {
    handlers.set("calculix_solve_static", options.solveHandler);
  }
  if (options.meshPreflightHandler) {
    handlers.set("calculix_mesh_preflight", options.meshPreflightHandler);
  }

  const logger = options.logger ??
    ((message: string) => console.error(`[mcp-calculix] ${message}`));
  const app = new McpApp({
    name: "mcp-calculix",
    version: VERSION,
    transport: "stateless",
    maxConcurrent: 4,
    backpressureStrategy: "queue",
    validateSchema: true,
    // Run evidence is registered both from the durable ledger at boot and
    // immediately after a successful solve, including after either transport starts.
    expectResources: true,
    instructions:
      "Bounded STEP analysis: mesh/selection preflight, linear static, modal, " +
      "linear buckling, Norton-law creep, and steady-state coupled " +
      "temperature-displacement. Mesh preflight stops before CalculiX and " +
      "reports mesh diagnostics only. Solve results report mesh and physical " +
      "observations; durable exact evidence is available for recorded static " +
      "solves, and no requirement verdict is produced.",
    logger,
  });
  app.registerTools(toolsClient.toMCPFormat(), handlers);
  for (const run of runStore.list()) {
    registerRecordedRunResources(app, runStore, run);
  }
  runStore.setLifecycleCallbacks({
    onRecord: (run) => {
      try {
        registerRecordedRunResources(app, runStore, run);
      } catch (error) {
        logger(
          `[WARN] Durable run ${run.runId} committed, but its MCP resources were not published; calculix_run_get or an exact retry will retry publication: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        throw error;
      }
    },
    onEvict: (run) => {
      for (const artifact of run.artifacts) {
        app.unregisterResource(artifact.uri);
      }
    },
  });
  const viewerRegistration = registerCalculixResultsViewer(
    app,
    options.viewerFileSystem,
    options.viewerModuleUrl,
  );
  const hasResultsViewer = viewerRegistration.registered.includes(
    "results-viewer",
  );
  return { app, hasResultsViewer, runStore, toolsClient };
}

function registerRecordedRunResources(
  app: McpApp,
  runStore: CalculixRunStore,
  run: RecordedStaticRun,
): void {
  const resources: MCPResource[] = [];
  const handlers = new Map<string, ResourceHandler>();
  for (const artifact of run.artifacts) {
    if (app.hasResource(artifact.uri)) continue;
    // Re-open and verify every artifact before exposing any URI from the run.
    runStore.readArtifactSync(artifact.uri);
    const uri = artifact.uri;
    resources.push({
      uri: artifact.uri,
      name: `CalculiX ${run.runId} ${artifact.name}`,
      description:
        `Exact ${artifact.name} from recorded CalculiX static run ${run.runId}; ` +
        `sha256:${artifact.sha256}, ${artifact.bytes} bytes.`,
      mimeType: artifact.mimeType,
      size: artifact.bytes,
    });
    handlers.set(uri, async (requested) => {
      if (requested.toString() !== uri) {
        throw new Error(
          "Requested URI does not match its registered artifact.",
        );
      }
      return await runStore.readArtifact(uri);
    });
  }
  if (resources.length > 0) app.registerResources(resources, handlers);
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
  if (cli.mode === "stdio") {
    await app.start();
  } else {
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
}

export type CliOptions =
  | { mode: "http"; port: number; hostname: string }
  | { mode: "stdio" };

/** Parse the deliberately small HTTP-or-native-stdio command surface. */
export function parseCli(args: readonly string[]): CliOptions {
  if (args.includes("--stdio")) {
    if (args.length !== 1) {
      throw new TypeError("--stdio cannot be combined with HTTP options.");
    }
    return { mode: "stdio" };
  }
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
  return { mode: "http", port, hostname };
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

function positiveIntegerEnv(name: string): number | undefined {
  const value = env(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return parsed;
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
