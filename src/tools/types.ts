/**
 * CalculiX tool contracts
 *
 * @module lib/calculix/tools/types
 */

import type { MCPTool, MCPToolMeta } from "@casys/mcp-server";

export type CalculixToolCategory = "solve";

export type CalculixToolHandler = (
  args: Record<string, unknown>,
) => Promise<unknown> | unknown;

/** CalculiX tool definition with handler */
export interface CalculixTool {
  name: string;
  description: string;
  category: CalculixToolCategory;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations?: MCPTool["annotations"];
  handler: CalculixToolHandler;
  _meta?: MCPToolMeta;
}
