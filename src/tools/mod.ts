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
export { createRecordedStaticTools } from "./solve.ts";
export type { RecordedStaticToolDependencies } from "./solve.ts";
export { modalTools } from "./modal.ts";
export { buckleTools } from "./buckling.ts";
export { creepTools } from "./creep.ts";
export { coupledThermalTools } from "./coupled_thermal.ts";

import { buckleTools } from "./buckling.ts";
import { coupledThermalTools } from "./coupled_thermal.ts";
import { creepTools } from "./creep.ts";
import { modalTools } from "./modal.ts";
import { solveTools } from "./solve.ts";
import { createRecordedStaticTools } from "./solve.ts";
import type { CalculixTool } from "./types.ts";
import type { CalculixRunStore } from "../runs.ts";

/** All CalculiX tools combined */
export const allTools: CalculixTool[] = [
  ...solveTools,
  ...modalTools,
  ...buckleTools,
  ...creepTools,
  ...coupledThermalTools,
];

/** Build the server tool surface, optionally including durable static runs. */
export function createAllTools(runStore?: CalculixRunStore): CalculixTool[] {
  return runStore
    ? [...allTools, ...createRecordedStaticTools(runStore)]
    : allTools;
}

/** Tools organized by category */
export const toolsByCategory: Record<string, CalculixTool[]> = {
  solve: [
    ...solveTools,
    ...modalTools,
    ...buckleTools,
    ...creepTools,
    ...coupledThermalTools,
  ],
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
