/**
 * CalculiX Tools Client
 *
 * Same pattern as the other Casys MCP servers.
 *
 * @module lib/calculix/client
 */

import {
  allTools,
  createAllTools,
  getCategories,
  getToolByName,
  getToolsByCategory,
  toolsByCategory,
} from "./tools/mod.ts";
import type { CalculixRunStore } from "./runs.ts";
import type {
  CalculixTool,
  CalculixToolCategory,
  CalculixToolHandler,
} from "./tools/mod.ts";
import type { MCPTool } from "@casys/mcp-server";

export {
  allTools,
  getCategories,
  getToolByName,
  getToolsByCategory,
  toolsByCategory,
};
export type { CalculixTool, CalculixToolCategory, CalculixToolHandler };

export interface MCPToolWireFormat {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations?: MCPTool["annotations"];
  _meta?: MCPTool["_meta"];
}

export interface CalculixToolsClientOptions {
  categories?: string[];
  runStore?: CalculixRunStore;
}

export class CalculixToolsClient {
  private tools: CalculixTool[];

  constructor(options?: CalculixToolsClientOptions) {
    const tools = options?.runStore
      ? createAllTools(options.runStore)
      : allTools;
    this.tools = options?.categories
      ? tools.filter((tool) => options.categories?.includes(tool.category))
      : tools;
  }

  listTools(): CalculixTool[] {
    return this.tools;
  }

  get count(): number {
    return this.tools.length;
  }

  toMCPFormat(): MCPToolWireFormat[] {
    return this.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema,
      annotations: t.annotations,
      _meta: t._meta,
    }));
  }

  buildHandlersMap(): Map<string, CalculixToolHandler> {
    const handlers = new Map<string, CalculixToolHandler>();
    for (const tool of this.tools) handlers.set(tool.name, tool.handler);
    return handlers;
  }
}
