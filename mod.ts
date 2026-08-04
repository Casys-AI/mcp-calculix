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

export {
  buckleTools,
  coupledThermalTools,
  creepTools,
  modalTools,
  solveTools,
} from "./src/tools/mod.ts";
export {
  BUCKLE_SOLVE_KIND,
  BUCKLE_SOLVE_OUTPUT_SCHEMA,
  BUCKLE_SOLVE_SCHEMA_VERSION,
  COUPLED_THERMAL_SOLVE_KIND,
  COUPLED_THERMAL_SOLVE_OUTPUT_SCHEMA,
  COUPLED_THERMAL_SOLVE_SCHEMA_VERSION,
  CREEP_SOLVE_KIND,
  CREEP_SOLVE_OUTPUT_SCHEMA,
  CREEP_SOLVE_SCHEMA_VERSION,
  MODAL_SOLVE_KIND,
  MODAL_SOLVE_OUTPUT_SCHEMA,
  MODAL_SOLVE_SCHEMA_VERSION,
  STATIC_SOLVE_KIND,
  STATIC_SOLVE_OUTPUT_SCHEMA,
  STATIC_SOLVE_SCHEMA_VERSION,
} from "./src/results.ts";
export type {
  BuckleSolveResult,
  CoupledThermalSolveResult,
  CreepSolveResult,
  ModalSolveResult,
  StaticSolveResult,
} from "./src/results.ts";

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
  buildBuckleDeck,
  buildCoupledThermalDeck,
  buildCreepDeck,
  buildDeck,
  buildModalDeck,
  CcxNotFoundError,
  parseBuckleDat,
  parseCoupledThermalDat,
  parseDat,
  parseDatLastIncrement,
  parseModalDat,
  solveBuckleDeck,
  solveCoupledThermalDeck,
  solveCreepDeck,
  solveDeck,
  SolveError,
  solveModalDeck,
} from "./src/api/ccx.ts";
export type {
  BuckleDeckOptions,
  BuckleResult,
  CoupledThermalDeckOptions,
  CoupledThermalResult,
  CreepDeckOptions,
  DeckOptions,
  Material,
  ModalDeckOptions,
  ModalResult,
  NodalLoad,
  SolveResult,
  ThermalBC,
} from "./src/api/ccx.ts";
