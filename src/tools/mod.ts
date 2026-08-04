/**
 * CalculiX tools — aggregated exports
 *
 * @module lib/calculix/tools/mod
 */

export type {
  CalculixTool,
  CalculixToolCategory,
  CalculixToolHandler,
} from "./types.ts";
export { solveTools } from "./solve.ts";
export { modalTools } from "./modal.ts";
export { buckleTools } from "./buckling.ts";

import { buckleTools } from "./buckling.ts";
import { modalTools } from "./modal.ts";
import { solveTools } from "./solve.ts";
import type { CalculixTool } from "./types.ts";

/** All CalculiX tools combined */
export const allTools: CalculixTool[] = [
  ...solveTools,
  ...modalTools,
  ...buckleTools,
];

/** Tools organized by category */
export const toolsByCategory: Record<string, CalculixTool[]> = {
  solve: [...solveTools, ...modalTools, ...buckleTools],
};

export function getToolsByCategory(category: string): CalculixTool[] {
  return toolsByCategory[category] || [];
}

export function getToolByName(name: string): CalculixTool | undefined {
  return allTools.find((t) => t.name === name);
}

export function getCategories(): string[] {
  return Object.keys(toolsByCategory);
}
