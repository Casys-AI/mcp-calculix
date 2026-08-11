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
  createRecordedStaticTools,
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
  RECORDED_INPUT_ARTIFACT_SCHEMA,
  RECORDED_STATIC_RUN_GET_OUTPUT_SCHEMA,
  RECORDED_STATIC_RUN_OUTPUT_SCHEMA,
  STATIC_SOLVE_KIND,
  STATIC_SOLVE_OUTPUT_SCHEMA,
  STATIC_SOLVE_RECORDED_KIND,
  STATIC_SOLVE_RECORDED_OUTPUT_SCHEMA,
  STATIC_SOLVE_RECORDED_SCHEMA_VERSION,
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
  meshStepRecorded,
} from "./src/api/gmsh.ts";
export type {
  FaceSelection,
  MeshOptions,
  MeshRecordedArtifacts,
  MeshResult,
  RecordedMeshResult,
} from "./src/api/gmsh.ts";
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
  solveDeckRecorded,
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
export {
  artifactUri,
  CalculixRunIntegrityError,
  CalculixRunStore,
  canonicalJson,
  DEFAULT_MAX_RECORDED_RUNS,
  DEFAULT_RUNS_DIRECTORY,
  parseRecordedStaticExecutionIdentity,
  RECORDED_ARTIFACTS,
  RECORDED_REQUEST_STATE_SCHEMA_VERSION,
  RECORDED_STATIC_RUN_SCHEMA_VERSION,
  resolveRecordedStaticRequest,
  validateRecordedStaticRequest,
} from "./src/runs.ts";
export type {
  CalculixRunStoreOptions,
  InputArtifactAttestation,
  RecordedArtifact,
  RecordedArtifactName,
  RecordedRequestClaim,
  RecordedRequestState,
  RecordedRunLookup,
  RecordedStaticExecutionIdentity,
  RecordedStaticRun,
  RecordedStaticRunPayload,
  RequestClaimResult,
  ValidatedRecordedStaticRequest,
} from "./src/runs.ts";
export { CalculixRunOutcomeUnknownError } from "./src/runs.ts";
