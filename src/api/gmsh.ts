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

export interface MeshOptions {
  stepPath: string;
  selections: FaceSelection[];
  /** Target element size in mm. Explicit — there is no sensible default. */
  meshSizeMm: number;
  /** 1 = linear tets (C3D4), 2 = quadratic (C3D10, better stresses). */
  elementOrder: 1 | 2;
  timeoutMs: number;
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
export function cleanInp(raw: string): string {
  const out: string[] = [];
  let skip = false;
  for (const line of raw.split("\n")) {
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
export function inspectInp(inpText: string): Omit<MeshResult, "inpText"> {
  let nodeCount = 0;
  let elementCount = 0;
  let maxNodeId = 0;
  const nodesPerSet: Record<string, number> = {};

  let section: "node" | "element" | "nset" | null = null;
  let currentSet = "";

  for (const line of inpText.split("\n")) {
    if (line.startsWith("*NODE")) {
      section = "node";
      continue;
    }
    if (line.startsWith("*ELEMENT")) {
      section = "element";
      continue;
    }
    if (line.startsWith("*NSET")) {
      section = "nset";
      currentSet = line.match(/NSET=(\w+)/)?.[1] ?? "";
      nodesPerSet[currentSet] = nodesPerSet[currentSet] ?? 0;
      continue;
    }
    if (line.startsWith("*")) {
      section = null;
      continue;
    }
    if (!line.trim()) continue;

    if (section === "node") {
      nodeCount++;
      const id = parseInt(line.split(",")[0], 10);
      if (id > maxNodeId) maxNodeId = id;
    } else if (section === "element") {
      // Continuation lines of a C3D10 element start with node ids only; count
      // lines that begin a new element (first field is the element id and the
      // previous line did not end with a comma).
      elementCount++;
    } else if (section === "nset" && currentSet) {
      nodesPerSet[currentSet] += line.split(",").filter((t) => t.trim()).length;
    }
  }

  return { nodeCount, elementCount, maxNodeId, nodesPerSet };
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
): Record<string, Set<number>> {
  const sets: Record<string, Set<number>> = {};
  let current: { name: string; generate: boolean } | null = null;

  for (const rawLine of inpText.split("\n")) {
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
        sets[name] = sets[name] ?? new Set<number>();
      } else {
        current = null;
      }
      continue;
    }
    if (!current || !line || line.startsWith("**")) continue;
    const numbers = line.split(",").map((token) => token.trim()).filter(
      Boolean,
    ).map(Number);
    if (current.generate) {
      applyGenerateRange(sets, current.name, numbers);
      continue;
    }
    for (const id of numbers) {
      if (!Number.isSafeInteger(id) || id < 1) {
        throw new Error(
          `NSET '${current.name}' contains an invalid node id.`,
        );
      }
      sets[current.name].add(id);
    }
  }
  return sets;
}

function applyGenerateRange(
  sets: Record<string, Set<number>>,
  name: string,
  values: number[],
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
    ids.add(id);
  }
  sets[name] = ids;
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
  // Preserve the legacy public path contract even though the recorded flow
  // subsequently copies it into a stable private relative input.
  if (/["\\\r\n]/.test(options.stepPath)) {
    throw new MeshingError(
      `STEP path contains characters that cannot be embedded safely in a ` +
        `.geo script (quote, backslash or newline): ${options.stepPath}`,
    );
  }
  try {
    await Deno.stat(options.stepPath);
  } catch {
    throw new MeshingError(`STEP file not found: ${options.stepPath}`);
  }

  const workDir = await Deno.makeTempDir({ prefix: "calculix-mesh-" });
  const geoPath = `${workDir}/mesh.geo`;
  const inpPath = `${workDir}/mesh.inp`;
  const stableInputPath = `${workDir}/input.step`;
  try {
    let inputStep: Uint8Array;
    try {
      // Do not interpolate a caller/private temporary path into the evidence.
      // The recorded program has a stable relative dependency and Gmsh runs in
      // the directory containing the exact private bytes.
      inputStep = await Deno.readFile(options.stepPath);
      if (inputStep.length < 1) {
        throw new MeshingError("STEP file is empty.");
      }
      await Deno.writeFile(stableInputPath, inputStep, { mode: 0o400 });
    } catch (error) {
      if (error instanceof MeshingError) throw error;
      throw new MeshingError(
        `Unable to prepare private STEP input: ${String(error)}`,
      );
    }
    const copiedInputStep = await Deno.readFile(stableInputPath);
    const inputStepSha256 = await sha256Hex(copiedInputStep);
    const geoText = buildGeoScript({ ...options, stepPath: "input.step" });
    await Deno.writeTextFile(geoPath, geoText);

    let child;
    try {
      child = new Deno.Command("gmsh", {
        args: ["mesh.geo", "-3", "-format", "inp", "-o", "mesh.inp"],
        cwd: workDir,
        stdout: "piped",
        stderr: "piped",
      }).spawn();
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) throw new GmshNotFoundError();
      throw error;
    }

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch { /* already exited */ }
    }, options.timeoutMs);
    let output: Deno.CommandOutput;
    try {
      output = await child.output();
    } finally {
      clearTimeout(timer);
    }
    const diagnostics = new TextDecoder().decode(output.stdout) +
      new TextDecoder().decode(output.stderr);

    if (!output.success) {
      throw new MeshingError(
        `gmsh failed (killed after ${options.timeoutMs}ms, or meshing error): ${
          diagnostics.slice(-800)
        }`,
      );
    }

    let raw: string;
    try {
      raw = await Deno.readTextFile(inpPath);
    } catch {
      throw new MeshingError("gmsh reported success but wrote no mesh file.");
    }

    const inpText = cleanInp(raw);
    const inspection = inspectInp(inpText);

    for (const selection of options.selections) {
      const count = inspection.nodesPerSet[selection.name] ?? 0;
      if (count === 0) {
        throw new MeshingError(
          `Selection '${selection.name}' matched no surface — its NSET is ` +
            `empty. Check the box against the part's bounding box ` +
            `(build123d_execute reports it), and remember coordinates are in mm.`,
        );
      }
    }

    return {
      mesh: { inpText, ...inspection },
      artifacts: {
        geoText,
        inputStepSha256,
        inputStepBytes: copiedInputStep.length,
        diagnostics,
        cleanedInpText: inpText,
      },
    };
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
