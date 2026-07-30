/**
 * MCP Server Bootstrap for CAD Tools
 *
 * Usage in an MCP config (stdio mode):
 * {
 *   "mcpServers": {
 *     "cad": {
 *       "command": "deno",
 *       "args": ["run", "--allow-all", "jsr:@casys/mcp-calculix/server"]
 *     }
 *   }
 * }
 *
 * HTTP mode (default port: 3015):
 *   deno run --allow-all server.ts --http --port=3015
 *
 * Environment:
 *   (none — gmsh and ccx are found on PATH; install with
 *    `apt install gmsh calculix-ccx`)
 *
 * @module lib/cad/server
 */

import { ConcurrentMCPServer } from "@casys/mcp-server";
import { CalculixToolsClient } from "./src/client.ts";

const DEFAULT_HTTP_PORT = 3015;

async function main() {
  const args = Deno.args;

  const categoriesArg = args.find((arg) => arg.startsWith("--categories="));
  const categories = categoriesArg ? categoriesArg.split("=")[1].split(",") : undefined;

  const httpFlag = args.includes("--http");
  const portArg = args.find((arg) => arg.startsWith("--port="));
  const httpPort = portArg ? parseInt(portArg.split("=")[1], 10) : DEFAULT_HTTP_PORT;
  const hostnameArg = args.find((arg) => arg.startsWith("--hostname="));
  const hostname = hostnameArg ? hostnameArg.split("=")[1] : "127.0.0.1"; // loopback by default — these tools execute code; exposing them is an explicit choice

  const toolsClient = new CalculixToolsClient(categories ? { categories } : undefined);

  const server = new ConcurrentMCPServer({
    name: "mcp-calculix",
    version: "0.1.1",
    maxConcurrent: 4,
    backpressureStrategy: "queue",
    validateSchema: true,
    logger: (msg) => console.error(`[mcp-calculix] ${msg}`),
  });

  server.registerTools(toolsClient.toMCPFormat(), toolsClient.buildHandlersMap());

  if (httpFlag) {
    await server.startHttp({
      port: httpPort,
      hostname,
      cors: true,
      onListen: (info) => {
        console.error(`[mcp-calculix] HTTP server listening on http://${info.hostname}:${info.port}`);
      },
    });
    console.error(`[mcp-calculix] Server ready (${toolsClient.count} tools) - HTTP mode`);
  } else {
    await server.start();
    console.error(`[mcp-calculix] Server ready (${toolsClient.count} tools) - stdio mode`);
  }

  Deno.addSignalListener("SIGINT", () => {
    console.error("[mcp-calculix] Shutting down...");
    Deno.exit(0);
  });
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("[mcp-calculix] Fatal error:", error);
    Deno.exit(1);
  });
}
