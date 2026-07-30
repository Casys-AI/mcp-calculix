/**
 * CalculiX tool contracts
 *
 * @module lib/calculix/tools/types
 */

import type { MCPToolMeta } from "@casys/mcp-server";

export type CalculixToolCategory = "solve";

export type CalculixToolHandler = (args: Record<string, unknown>) => Promise<unknown> | unknown;

/** CalculiX tool definition with handler */
export interface CalculixTool {
  name: string;
  description: string;
  category: CalculixToolCategory;
  inputSchema: Record<string, unknown>;
  handler: CalculixToolHandler;
  _meta?: MCPToolMeta;
}
