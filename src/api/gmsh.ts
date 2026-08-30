/**
 * Gmsh bridge — STEP file → Abaqus mesh with named node sets
 *
 * Face designation works by axis-aligned bounding boxes: each selection names
 * the surfaces enclosed in a box, which Gmsh turns into a physical group and
 * the Abaqus export turns into an NSET the solver can reference. Validated
 * against Gmsh 4.8.
 *
 * The exported .inp is cleaned before use: Gmsh writes the surface triangles
 * of every physical surface as CPS6 elements, which CalculiX rejects in a 3D
 * analysis (elements without a section). Only volume elements survive.
 *
 * @module lib/calculix/api/gmsh
 */

import {
  assertBudget,
  copyFileBounded,
  hashFileBounded,
  MAX_DIAGNOSTICS_BYTES,
  MAX_MESH_ELEMENTS,
  MAX_MESH_INP_BYTES,
  MAX_MESH_LINES,
  MAX_MESH_NODES,
  MAX_NSET_ENTRIES,
  MAX_NSET_NODES,
  MAX_NSET_SETS,
  MAX_STEP_BYTES,
  MAX_TOTAL_NSET_MEMBERSHIPS,
  readTextFileBounded,
  ResourceBudgetError,
  runBoundedCommand,
  tightenBudget,
} from "./budgets.ts";

/** Raised when the gmsh executable cannot be found. */
export class GmshNotFoundError extends Error {
  constructor() {
    super(
      "The gmsh executable was not found on PATH. Install it first: " +
        "`apt install gmsh` (Debian/Ubuntu), `brew install gmsh` (macOS).",
    );
    this.name = "GmshNotFoundError";
  }
}

/** Raised on meshing failures, with gmsh's own output attached. */
export class MeshingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeshingError";
  }
}

/** A named face selection: every surface enclosed in the box. */
export interface FaceSelection {
  name: string;
  box: { min: [number, number, number]; max: [number, number, number] };
}

export interface MeshCardinalityLimits {
  maxMeshNodes?: number;
  maxMeshElements?: number;
  maxMeshLines?: number;
  maxNsetNodes?: number;
  maxNsetEntries?: number;
  maxNsetSets?: number;
  maxTotalNsetMemberships?: number;
}

export interface MeshIoBudgets extends MeshCardinalityLimits {
  maxDiagnosticsBytes?: number;
  maxMeshInpBytes?: number;
  maxStepBytes?: number;
}

export interface MeshOptions {
  stepPath: string;
  selections: FaceSelection[];
  /** Target element size in mm. Explicit — there is no sensible default. */
  meshSizeMm: number;
  /** 1 = linear tets (C3D4), 2 = quadratic (C3D10, better stresses). */
  elementOrder: 1 | 2;
  timeoutMs: number;
  /** Optional tighter budgets; values above the fleet maxima are ignored. */
  budgets?: MeshIoBudgets;
}

export interface MeshResult {
  /** Cleaned Abaqus mesh: volume elements + node sets only. */
  inpText: string;
  nodeCount: number;
  elementCount: number;
  /** Highest node id, needed to generate the all-nodes set for the deck. */
  maxNodeId: number;
  /** Node count per selection NSET — a selection matching nothing is an error upstream. */
  nodesPerSet: Record<string, number>;
}

/** Exact, text artifacts emitted during one Gmsh invocation. */
export interface MeshRecordedArtifacts {
  /** The `.geo` program actually handed to Gmsh. */
  geoText: string;
  /** SHA-256 of the private `input.step` copy resolved by the recorded .geo. */
  inputStepSha256: string;
  /** Exact byte length of the private `input.step` copy resolved by Gmsh. */
  inputStepBytes: number;
  /** Gmsh stdout and stderr, concatenated in process order groups. */
  diagnostics: string;
  /** Cleaned Abaqus mesh actually used to build the CalculiX deck. */
  cleanedInpText: string;
}

export interface RecordedMeshResult {
  mesh: MeshResult;
  artifacts: MeshRecordedArtifacts;
}

/** Coordinate extent of the nodes written in a cleaned Abaqus mesh, in mm. */
export interface MeshBounds {
  min: [number, number, number];
  max: [number, number, number];
}

/** A valid named selection which did not receive any mesh nodes. */
export interface MeshSelectionError {
  selection: string;
  code: "empty_selection";
  message: string;
}

/**
 * Ephemeral mesh-only diagnostic. It deliberately contains no CalculiX deck,
 * solver output, or durable resource reference.
 */
export interface MeshPreflightResult {
  mesh: MeshResult;
  /** Bounds of emitted mesh nodes, not a CAD topology or solid-body claim. */
  bounds: MeshBounds;
  selectionErrors: MeshSelectionError[];
}

interface MeshWithSelectionDiagnostics {
  recorded: RecordedMeshResult;
  selectionErrors: MeshSelectionError[];
}

/** NSET names are written into the deck — keep them strictly boring. */
export function validateSetName(name: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(name)) {
    throw new MeshingError(
      `Selection name '${name}' is invalid. Use letters, digits and ` +
        `underscores, starting with a letter (it becomes an Abaqus NSET name).`,
    );
  }
}

/** Build the .geo script driving Gmsh. */
export function buildGeoScript(options: MeshOptions): string {
  const lines: string[] = [];
  // Gmsh resolves Merge relative to the .geo file. Recorded execution passes
  // the stable private name `input.step`; legacy callers may still pass paths.
  lines.push(`Merge "${options.stepPath}";`);

  for (const selection of options.selections) {
    validateSetName(selection.name);
    const [minCorner, maxCorner] = [selection.box.min, selection.box.max];
    for (const [lo, hi] of [0, 1, 2].map((i) => [minCorner[i], maxCorner[i]])) {
      if (!(Number.isFinite(lo) && Number.isFinite(hi) && lo < hi)) {
        throw new MeshingError(
          `Selection '${selection.name}': box min must be strictly below max ` +
            `on every axis (got min=${JSON.stringify(minCorner)}, max=${
              JSON.stringify(maxCorner)
            }).`,
        );
      }
    }
    lines.push(
      `${selection.name}() = Surface In BoundingBox{` +
        `${minCorner.join(", ")}, ${maxCorner.join(", ")}};`,
      `Physical Surface("${selection.name}") = ${selection.name}();`,
    );
  }

  lines.push(
    `Physical Volume("PART") = {1};`,
    `Mesh.CharacteristicLengthMax = ${options.meshSizeMm};`,
    `Mesh.ElementOrder = ${options.elementOrder};`,
    `Mesh.SaveGroupsOfNodes = 1;`,
  );
  return lines.join("\n") + "\n";
}

/**
 * Strip everything CalculiX cannot digest: keep *NODE blocks, volume
 * *ELEMENT blocks (C3D*) and *NSET blocks. Surface/line elements and their
 * ELSETs go.
 */
export function cleanInp(
  raw: string,
  limits?: MeshCardinalityLimits,
): string {
  const maxMeshLines = resolveMeshCardinalityLimits(limits).maxMeshLines;
  const out: string[] = [];
  let skip = false;
  for (const line of boundedLines(raw, maxMeshLines)) {
    if (line.startsWith("*ELEMENT")) {
      skip = !line.includes("type=C3D");
    } else if (line.startsWith("*ELSET")) {
      // ELSETs referencing stripped surface elements would dangle; the deck
      // only needs the PART volume elset, which Gmsh emits with the elements.
      skip = !line.includes("ELSET=PART") && !line.includes("ELSET=Volume");
    } else if (line.startsWith("*")) {
      skip = false;
    }
    if (!skip) out.push(line);
  }
  return out.join("\n");
}

/** Parse node/element counts and per-NSET sizes out of a cleaned .inp. */
export function inspectInp(
  inpText: string,
  limits?: MeshCardinalityLimits,
): Omit<MeshResult, "inpText"> {
  const cardinality = resolveMeshCardinalityLimits(limits);
  let nodeCount = 0;
  let elementCount = 0;
  let maxNodeId = 0;
  const nodeIds = new Set<number>();
  const nsetNames = new Map<string, string>();

  let section: "node" | "element" | "nset" | null = null;
  let currentSet = "";
  let elementContinues = false;

  for (const rawLine of boundedLines(inpText, cardinality.maxMeshLines)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("**")) continue;
    if (/^\*NODE\b/i.test(line)) {
      section = "node";
      elementContinues = false;
      continue;
    }
    if (/^\*ELEMENT\b/i.test(line)) {
      section = "element";
      elementContinues = false;
      continue;
    }
    if (/^\*NSET\b/i.test(line)) {
      section = "nset";
      currentSet = line.match(/NSET\s*=\s*([A-Za-z][A-Za-z0-9_]*)/i)?.[1] ?? "";
      if (currentSet) {
        const canonical = currentSet.toUpperCase();
        if (!nsetNames.has(canonical)) {
          assertBudget(
            nsetNames.size + 1,
            cardinality.maxNsetSets,
            "output_limit",
            "nset_sets",
            "count",
          );
          nsetNames.set(canonical, currentSet);
        }
      }
      elementContinues = false;
      continue;
    }
    if (line.startsWith("*")) {
      section = null;
      elementContinues = false;
      continue;
    }
    if (section === "node") {
      const id = parseInt(line.split(",")[0], 10);
      if (!Number.isSafeInteger(id) || id < 1) {
        throw new MeshingError("Cleaned mesh contains an invalid *NODE id.");
      }
      if (nodeIds.has(id)) {
        throw new MeshingError(
          `Cleaned mesh contains duplicate *NODE id ${id}.`,
        );
      }
      nodeIds.add(id);
      nodeCount++;
      assertBudget(
        nodeCount,
        cardinality.maxMeshNodes,
        "output_limit",
        "mesh_nodes",
        "count",
      );
      if (id > maxNodeId) maxNodeId = id;
    } else if (section === "element") {
      // Continuation lines of a C3D10 element start with node ids only; count
      // lines that begin a new element (first field is the element id and the
      // previous line did not end with a comma).
      if (!elementContinues) {
        elementCount++;
        assertBudget(
          elementCount,
          cardinality.maxMeshElements,
          "output_limit",
          "mesh_elements",
          "count",
        );
      }
      elementContinues = line.endsWith(",");
    }
  }
  const parsedSets = parseNsetNodeIds(inpText, cardinality);
  const nodesPerSet = Object.fromEntries(
    [...nsetNames].map((
      [canonical, presented],
    ) => [presented, parsedSets[canonical]?.size ?? 0]),
  );
  return { nodeCount, elementCount, maxNodeId, nodesPerSet };
}

/**
 * Read the coordinate extent from the exact cleaned mesh text. This is kept
 * separate from `inspectInp` so ordinary solve callers retain their existing
 * result contract.
 */
export function inspectMeshNodeBounds(
  inpText: string,
  limits?: MeshCardinalityLimits,
): MeshBounds {
  const cardinality = resolveMeshCardinalityLimits(limits);
  let inNodeSection = false;
  let nodeCount = 0;
  const nodeIds = new Set<number>();
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  for (const rawLine of boundedLines(inpText, cardinality.maxMeshLines)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("**")) continue;
    if (line.startsWith("*")) {
      inNodeSection = /^\*NODE\b/i.test(line);
      continue;
    }
    if (!inNodeSection) continue;

    const fields = line.split(",").map((field) => field.trim());
    if (fields.length !== 4 || fields.some((field) => field.length === 0)) {
      throw new MeshingError(
        "Cleaned mesh contains a malformed *NODE record while reading bounds.",
      );
    }
    const nodeId = Number(fields[0]);
    const coordinates = fields.slice(1).map(Number);
    if (
      !Number.isSafeInteger(nodeId) || nodeId < 1 ||
      coordinates.length !== 3 || !coordinates.every(Number.isFinite)
    ) {
      throw new MeshingError(
        "Cleaned mesh contains a non-finite or invalid *NODE record while reading bounds.",
      );
    }
    if (nodeIds.has(nodeId)) {
      throw new MeshingError(
        `Cleaned mesh contains duplicate *NODE id ${nodeId}.`,
      );
    }
    nodeIds.add(nodeId);
    for (const axis of [0, 1, 2] as const) {
      min[axis] = Math.min(min[axis], coordinates[axis]);
      max[axis] = Math.max(max[axis], coordinates[axis]);
    }
    nodeCount++;
    assertBudget(
      nodeCount,
      cardinality.maxMeshNodes,
      "output_limit",
      "mesh_nodes",
      "count",
    );
  }

  if (nodeCount === 0) {
    throw new MeshingError("Cleaned mesh contains no *NODE records.");
  }
  return { min, max };
}

/**
 * Collect actual node IDs from cleaned Abaqus *NSET blocks.
 *
 * Supports wrapped comma-separated lists and `GENERATE` form, where each
 * non-empty data line is one independent `start, end[, increment]` range.
 * Duplicate *NSET headers for the same name are unioned. Keywords and
 * names are matched case-insensitively; returned keys are uppercase.
 * Independent from `inspectInp` token counting.
 */
export function parseNsetNodeIds(
  inpText: string,
  limits?: MeshCardinalityLimits,
): Record<string, Set<number>> {
  const cardinality = resolveMeshCardinalityLimits(limits);
  const maxNsetNodes = cardinality.maxNsetNodes;
  const sets: Record<string, Set<number>> = {};
  const entries = {
    total: 0,
    limit: cardinality.maxNsetEntries,
  };
  const memberships = {
    total: 0,
    limit: cardinality.maxTotalNsetMemberships,
  };
  let current: { name: string; generate: boolean } | null = null;

  for (const rawLine of boundedLines(inpText, cardinality.maxMeshLines)) {
    const line = rawLine.trim();
    if (line.startsWith("*")) {
      if (/^\*nset\b/i.test(line)) {
        const rawName = line.match(/nset\s*=\s*([A-Za-z][A-Za-z0-9_]*)/i)?.[1];
        if (!rawName) {
          current = null;
          continue;
        }
        const name = rawName.toUpperCase();
        current = { name, generate: /\bGENERATE\b/i.test(line) };
        if (sets[name] === undefined) {
          assertBudget(
            Object.keys(sets).length + 1,
            cardinality.maxNsetSets,
            "output_limit",
            "nset_sets",
            "count",
          );
          sets[name] = new Set<number>();
        }
      } else {
        current = null;
      }
      continue;
    }
    if (!current || !line || line.startsWith("**")) continue;
    if (current.generate) {
      const numbers: number[] = [];
      for (const number of commaSeparatedNumbers(line)) {
        numbers.push(number);
        if (numbers.length > 3) break;
      }
      applyGenerateRange(
        sets,
        current.name,
        numbers,
        maxNsetNodes,
        entries,
        memberships,
      );
      continue;
    }
    for (const id of commaSeparatedNumbers(line)) {
      entries.total++;
      assertBudget(
        entries.total,
        entries.limit,
        "output_limit",
        "nset_entries",
        "count",
      );
      if (!Number.isSafeInteger(id) || id < 1) {
        throw new Error(
          `NSET '${current.name}' contains an invalid node id.`,
        );
      }
      const before = sets[current.name].size;
      sets[current.name].add(id);
      if (sets[current.name].size !== before) memberships.total++;
      assertBudget(
        sets[current.name].size,
        maxNsetNodes,
        "output_limit",
        "nset_nodes",
        "count",
      );
      assertBudget(
        memberships.total,
        memberships.limit,
        "output_limit",
        "nset_memberships",
        "count",
      );
    }
  }
  return sets;
}

function applyGenerateRange(
  sets: Record<string, Set<number>>,
  name: string,
  values: number[],
  maxNsetNodes: number,
  entries: { total: number; limit: number },
  memberships: { total: number; limit: number },
): void {
  if (values.length !== 2 && values.length !== 3) {
    throw new Error(
      `NSET '${name}' GENERATE form requires start, end[, increment].`,
    );
  }
  const start = values[0];
  const end = values[1];
  const step = values[2] ?? 1;
  if (
    !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(step) || step === 0
  ) {
    throw new Error(`NSET '${name}' GENERATE bounds are invalid.`);
  }
  const ids = sets[name] ?? new Set<number>();
  const ascending = step > 0;
  if ((ascending && start > end) || (!ascending && start < end)) {
    sets[name] = ids;
    return;
  }
  const rangeCount = generateRangeCount(start, end, step);
  assertBudget(
    rangeCount,
    maxNsetNodes,
    "output_limit",
    "nset_nodes",
    "count",
  );
  entries.total += rangeCount;
  assertBudget(
    entries.total,
    entries.limit,
    "output_limit",
    "nset_entries",
    "count",
  );
  for (
    let id = start;
    ascending ? id <= end : id >= end;
    id += step
  ) {
    if (id < 1) {
      throw new Error(
        `NSET '${name}' GENERATE produced a non-positive node id.`,
      );
    }
    const before = ids.size;
    ids.add(id);
    if (ids.size !== before) memberships.total++;
    assertBudget(
      ids.size,
      maxNsetNodes,
      "output_limit",
      "nset_nodes",
      "count",
    );
    assertBudget(
      memberships.total,
      memberships.limit,
      "output_limit",
      "nset_memberships",
      "count",
    );
  }
  sets[name] = ids;
}

/** Parse one comma-delimited NSET line without allocating an array of tokens. */
function* commaSeparatedNumbers(line: string): Generator<number> {
  let start = 0;
  while (start <= line.length) {
    const comma = line.indexOf(",", start);
    const end = comma === -1 ? line.length : comma;
    const token = line.slice(start, end).trim();
    if (token.length > 0) yield Number(token);
    if (comma === -1) return;
    start = comma + 1;
  }
}

/** Iterate mesh text without allocating one array entry per line. */
function* boundedLines(text: string, limit: number): Generator<string> {
  let start = 0;
  let lines = 0;
  while (start <= text.length) {
    lines++;
    assertBudget(lines, limit, "output_limit", "mesh_lines", "count");
    const newline = text.indexOf("\n", start);
    if (newline === -1) {
      yield text.slice(start);
      return;
    }
    yield text.slice(start, newline);
    start = newline + 1;
  }
}

function generateRangeCount(start: number, end: number, step: number): number {
  const absStep = Math.abs(step);
  const distance = Math.abs(end - start);
  if (absStep < 1) return Number.POSITIVE_INFINITY;
  if (distance / absStep >= Number.MAX_SAFE_INTEGER) {
    return Number.MAX_SAFE_INTEGER + 1;
  }
  return Math.floor(distance / absStep) + 1;
}

function resolveMeshCardinalityLimits(limits?: MeshCardinalityLimits): {
  maxMeshNodes: number;
  maxMeshElements: number;
  maxMeshLines: number;
  maxNsetNodes: number;
  maxNsetEntries: number;
  maxNsetSets: number;
  maxTotalNsetMemberships: number;
} {
  return {
    maxMeshNodes: tightenBudget(limits?.maxMeshNodes, MAX_MESH_NODES),
    maxMeshElements: tightenBudget(limits?.maxMeshElements, MAX_MESH_ELEMENTS),
    maxMeshLines: tightenBudget(limits?.maxMeshLines, MAX_MESH_LINES),
    maxNsetNodes: tightenBudget(limits?.maxNsetNodes, MAX_NSET_NODES),
    maxNsetEntries: tightenBudget(
      limits?.maxNsetEntries,
      MAX_NSET_ENTRIES,
    ),
    maxNsetSets: tightenBudget(limits?.maxNsetSets, MAX_NSET_SETS),
    maxTotalNsetMemberships: tightenBudget(
      limits?.maxTotalNsetMemberships,
      MAX_TOTAL_NSET_MEMBERSHIPS,
    ),
  };
}

/** Run Gmsh on a STEP file and return the cleaned mesh. */
export async function meshStep(options: MeshOptions): Promise<MeshResult> {
  return (await meshStepRecorded(options)).mesh;
}

/**
 * Mesh a STEP snapshot and retain the exact textual artifacts long enough for
 * a caller to put them in its own durable evidence store.  This API does not
 * choose where evidence lives; tools own that lifecycle.
 */
export async function meshStepRecorded(
  options: MeshOptions,
): Promise<RecordedMeshResult> {
  const result = await meshStepWithSelectionDiagnostics(options);
  const selectionError = result.selectionErrors[0];
  if (selectionError) throw new MeshingError(selectionError.message);
  return result.recorded;
}

/**
 * Mesh a STEP snapshot without invoking CalculiX. Empty named selections are
 * returned as diagnostics so callers can correct boxes before a solve.
 */
export async function meshStepPreflight(
  options: MeshOptions,
): Promise<MeshPreflightResult> {
  const result = await meshStepWithSelectionDiagnostics(options);
  return {
    mesh: result.recorded.mesh,
    bounds: inspectMeshNodeBounds(
      result.recorded.mesh.inpText,
      options.budgets,
    ),
    selectionErrors: result.selectionErrors,
  };
}

async function meshStepWithSelectionDiagnostics(
  options: MeshOptions,
): Promise<MeshWithSelectionDiagnostics> {
  // Preserve the legacy public path contract even though the recorded flow
  // subsequently copies it into a stable private relative input.
  if (/["\\\r\n]/.test(options.stepPath)) {
    throw new MeshingError(
      `STEP path contains characters that cannot be embedded safely in a ` +
        `.geo script (quote, backslash or newline): ${options.stepPath}`,
    );
  }
  const workDir = await Deno.makeTempDir({ prefix: "calculix-mesh-" });
  const geoPath = `${workDir}/mesh.geo`;
  const inpPath = `${workDir}/mesh.inp`;
  const stableInputPath = `${workDir}/input.step`;
  try {
    const maxStepBytes = tightenBudget(
      options.budgets?.maxStepBytes,
      MAX_STEP_BYTES,
    );
    const maxDiagnosticsBytes = tightenBudget(
      options.budgets?.maxDiagnosticsBytes,
      MAX_DIAGNOSTICS_BYTES,
    );
    const maxMeshInpBytes = tightenBudget(
      options.budgets?.maxMeshInpBytes,
      MAX_MESH_INP_BYTES,
    );
    let hashedInput: { sha256: string; bytes: number };
    try {
      // Do not interpolate a caller/private temporary path into the evidence.
      // The recorded program has a stable relative dependency and Gmsh runs in
      // the directory containing the exact private bytes.
      const copiedBytes = await copyFileBounded(
        options.stepPath,
        stableInputPath,
        maxStepBytes,
        "step_bytes",
      );
      if (copiedBytes < 1) {
        throw new MeshingError("STEP file is empty.");
      }
      await Deno.chmod(stableInputPath, 0o400);
      hashedInput = await hashFileBounded(
        stableInputPath,
        maxStepBytes,
        "step_bytes",
      );
      if (hashedInput.bytes < 1) {
        throw new MeshingError("STEP file is empty.");
      }
    } catch (error) {
      if (error instanceof MeshingError) throw error;
      if (error instanceof ResourceBudgetError) throw error;
      throw new MeshingError(
        `Unable to prepare private STEP input: ${String(error)}`,
      );
    }
    const geoText = buildGeoScript({ ...options, stepPath: "input.step" });
    await Deno.writeTextFile(geoPath, geoText);

    let output: Awaited<ReturnType<typeof runBoundedCommand>>;
    try {
      output = await runBoundedCommand({
        command: "gmsh",
        args: ["mesh.geo", "-3", "-format", "inp", "-o", "mesh.inp"],
        cwd: workDir,
        timeoutMs: options.timeoutMs,
        maxOutputBytes: maxDiagnosticsBytes,
        resource: "gmsh_diagnostics",
      });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) throw new GmshNotFoundError();
      throw error;
    }
    const diagnostics = output.diagnostics;

    if (!output.success) {
      throw new MeshingError(
        `gmsh failed (killed after ${options.timeoutMs}ms, or meshing error): ${
          diagnostics.slice(-800)
        }`,
      );
    }

    let raw: string;
    try {
      raw = await readTextFileBounded(
        inpPath,
        maxMeshInpBytes,
        "output_limit",
        "mesh_inp_bytes",
      );
    } catch (error) {
      if (error instanceof ResourceBudgetError) throw error;
      throw new MeshingError("gmsh reported success but wrote no mesh file.");
    }

    const inpText = cleanInp(raw, options.budgets);
    const inspection = inspectInp(inpText, options.budgets);

    const selectionErrors = options.selections.flatMap((selection) => {
      const count = inspection.nodesPerSet[selection.name] ?? 0;
      if (count > 0) return [];
      return [{
        selection: selection.name,
        code: "empty_selection" as const,
        message:
          `Selection '${selection.name}' matched no surface — its NSET is ` +
          "empty. Check the box against the mesh coordinate bounds and " +
          "remember coordinates are in mm.",
      }];
    });

    return {
      recorded: {
        mesh: { inpText, ...inspection },
        artifacts: {
          geoText,
          inputStepSha256: hashedInput.sha256,
          inputStepBytes: hashedInput.bytes,
          diagnostics,
          cleanedInpText: inpText,
        },
      },
      selectionErrors,
    };
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
  }
}
