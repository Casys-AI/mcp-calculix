/**
 * @casys/mcp-calculix
 *
 * MCP tools for finite element analysis of STEP parts: Gmsh meshing plus
 * CalculiX linear static, modal, linear buckling, Norton-law creep, and
 * steady-state coupled temperature-displacement analyses, with faces
 * designated by named bounding boxes.
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
  createMeshPreflightTools,
  createRecordedStaticTools,
  creepTools,
  MESH_PREFLIGHT_INPUT_SCHEMA,
  MESH_PREFLIGHT_TOOL_NAME,
  meshPreflightTools,
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
  MESH_PREFLIGHT_KIND,
  MESH_PREFLIGHT_OUTPUT_SCHEMA,
  MESH_PREFLIGHT_SCHEMA_VERSION,
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
  MeshPreflightResult,
  ModalSolveResult,
  StaticSolveResult,
} from "./src/results.ts";

export {
  mapCalculixToolError,
  MAX_DECK_BYTES,
  MAX_DIAGNOSTICS_BYTES,
  MAX_JOB_DAT_BYTES,
  MAX_MESH_ELEMENTS,
  MAX_MESH_INP_BYTES,
  MAX_MESH_LINES,
  MAX_MESH_NODES,
  MAX_NSET_ENTRIES,
  MAX_NSET_NODES,
  MAX_NSET_SETS,
  MAX_SELECTIONS,
  MAX_SOLVE_TIMEOUT_MS,
  MAX_STEP_BYTES,
  MAX_TOTAL_NSET_MEMBERSHIPS,
  MAX_VERSION_PROBE_BYTES,
  ResourceBudgetError,
} from "./src/api/budgets.ts";
export type {
  ResourceBudgetCode,
  ResourceBudgetContext,
  ResourceBudgetName,
  ResourceBudgetUnit,
} from "./src/api/budgets.ts";
export {
  buildGeoScript,
  cleanInp,
  GmshNotFoundError,
  inspectInp,
  inspectMeshNodeBounds,
  MeshingError,
  meshStep,
  meshStepPreflight,
  meshStepRecorded,
  parseNsetNodeIds,
} from "./src/api/gmsh.ts";
export type {
  FaceSelection,
  MeshBounds,
  MeshOptions,
  MeshPreflightResult as GmshMeshPreflightResult,
  MeshRecordedArtifacts,
  MeshResult,
  MeshSelectionError,
  RecordedMeshResult,
} from "./src/api/gmsh.ts";
export {
  assertMechanicalFixedAndLoadNodeDisjoint,
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
  parseDatLastIncrementObserved,
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
  LastIncrementResult,
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

export {
  CALCULIX_RESULT_SCHEMA_IDS,
  CALCULIX_RESULTS_VIEWER_URI,
  CALCULIX_VIEW_APP_MANIFEST,
  CALCULIX_VIEWER_SESSION_KIND,
  CALCULIX_VIEWER_SESSION_SCHEMA,
  calculixRecordedSessionFingerprint,
  parseCalculixIsolatedStaticResult,
  parseCalculixRecordedResultDocument,
  parseCalculixRecordedRun,
  parseCalculixRecordedStaticResult,
  parseCalculixViewerSession,
  VIEW_APP_MANIFEST_SCHEMA,
  VIEWER_SESSION_APPLY_ACTION,
} from "./src/viewer-session.ts";
export type {
  CalculixIsolatedStaticResult,
  CalculixRecordedArtifact,
  CalculixRecordedRun,
  CalculixRecordedStaticResult,
  CalculixStaticObservations,
  CalculixViewAppManifest,
  CalculixViewerSession,
  CalculixViewerSessionAnchor,
  CalculixViewerSessionBasis,
  CalculixViewerSessionProjection,
  CalculixViewerSessionProvenance,
} from "./src/viewer-session.ts";
