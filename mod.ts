/**
 * @casys/mcp-calculix
 *
 * MCP tools for finite element analysis: Gmsh meshing + CalculiX linear
 * static solve on STEP files, with faces designated by named bounding boxes.
 *
 * @module
 */

export {
  allTools,
  CalculixToolsClient,
  getCategories,
  getToolByName,
  getToolsByCategory,
  toolsByCategory,
} from "./src/client.ts";
export type {
  CalculixTool,
  CalculixToolCategory,
  CalculixToolHandler,
  CalculixToolsClientOptions,
  MCPToolWireFormat,
} from "./src/client.ts";

export { solveTools } from "./src/tools/mod.ts";
export {
  STATIC_SOLVE_KIND,
  STATIC_SOLVE_OUTPUT_SCHEMA,
  STATIC_SOLVE_SCHEMA_VERSION,
} from "./src/results.ts";
export type { StaticSolveResult } from "./src/results.ts";

export {
  buildGeoScript,
  cleanInp,
  GmshNotFoundError,
  inspectInp,
  MeshingError,
  meshStep,
} from "./src/api/gmsh.ts";
export type { FaceSelection, MeshOptions, MeshResult } from "./src/api/gmsh.ts";
export {
  buildDeck,
  CcxNotFoundError,
  parseDat,
  solveDeck,
  SolveError,
} from "./src/api/ccx.ts";
export type {
  DeckOptions,
  Material,
  NodalLoad,
  SolveResult,
} from "./src/api/ccx.ts";
