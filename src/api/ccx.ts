/**
 * CalculiX bridge — deck generation, solve, result parsing
 *
 * The deck is plain Abaqus-format text; results are read from the .dat file
 * (*NODE PRINT / *EL PRINT output), which is stable and line-oriented —
 * far simpler than the binary-ish .frd.
 *
 * Von Mises stress is computed here from the six stress components CalculiX
 * prints per integration point.
 *
 * @module lib/calculix/api/ccx
 */

import { parseNsetNodeIds } from "./gmsh.ts";

/** Raised when the ccx executable cannot be found. */
export class CcxNotFoundError extends Error {
  constructor() {
    super(
      "The CalculiX executable 'ccx' was not found on PATH. Install it " +
        "first: `apt install calculix-ccx` (Debian/Ubuntu), " +
        "`brew install calculix` (macOS).",
    );
    this.name = "CcxNotFoundError";
  }
}

/** Raised on solver failures, with the tail of CalculiX's output. */
export class SolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolveError";
  }
}

export interface Material {
  /** Young's modulus in MPa (70000 for Al 6061, 210000 for steel). */
  eMpa: number;
  /** Poisson's ratio. */
  nu: number;
}

export interface NodalLoad {
  /** Name of the face selection whose nodes carry the load. */
  selection: string;
  /** TOTAL force in N, distributed evenly over the set's nodes. */
  totalForceN: [number, number, number];
}

export interface DeckOptions {
  /** Cleaned mesh from the gmsh bridge. */
  inpText: string;
  maxNodeId: number;
  material: Material;
  /** Selections whose nodes are fully fixed (all three translations). */
  fixed: string[];
  loads: NodalLoad[];
  /** Node count per set, to split total forces into per-node values. */
  nodesPerSet: Record<string, number>;
}

/**
 * Reject a mechanical fixed selection and a mechanical load selection that
 * share actual node IDs, even when the selection names differ. Thermal BCs
 * are not passed here and are never treated as mechanical loads.
 *
 * Call this on new native execution after the mesh exists. Recorded replay
 * rebuilds job.inp with `buildDeck` and must not invoke this guard.
 */
export function assertMechanicalFixedAndLoadNodeDisjoint(
  inpText: string,
  fixed: string[],
  loadSelections: string[],
): void {
  if (loadSelections.length === 0) return;
  let sets: Record<string, Set<number>>;
  try {
    sets = parseNsetNodeIds(inpText);
  } catch (error) {
    throw new SolveError(
      error instanceof Error ? error.message : String(error),
    );
  }
  const owner = new Map<number, string>();
  for (const name of fixed) {
    const nodes = sets[name.toUpperCase()];
    if (!nodes || nodes.size === 0) {
      throw new SolveError(
        `Fixed selection '${name}' has no node ids in the mesh NSET.`,
      );
    }
    for (const id of nodes) {
      if (!owner.has(id)) owner.set(id, name);
    }
  }
  for (const name of loadSelections) {
    const nodes = sets[name.toUpperCase()];
    if (!nodes || nodes.size === 0) {
      throw new SolveError(
        `Load selection '${name}' has no node ids in the mesh NSET.`,
      );
    }
    for (const id of nodes) {
      const fixedName = owner.get(id);
      if (fixedName !== undefined) {
        throw new SolveError(
          `Mechanical fixed selection '${fixedName}' and load selection ` +
            `'${name}' share node ${id}.`,
        );
      }
    }
  }
}

/** Build the complete CalculiX input deck. */
export function buildDeck(options: DeckOptions): string {
  const { material } = options;
  if (!(material.eMpa > 0) || !(material.nu > 0 && material.nu < 0.5)) {
    throw new SolveError(
      `Material out of range: e_mpa must be > 0 and nu in (0, 0.5), got ` +
        `e_mpa=${material.eMpa}, nu=${material.nu}.`,
    );
  }

  const lines: string[] = [options.inpText.trimEnd()];

  // CalculiX silently skips *NODE PRINT on an undefined set — generate the
  // all-nodes set instead of trusting the mesh to provide one.
  lines.push(
    `*NSET, NSET=NALL, GENERATE`,
    `1, ${options.maxNodeId}`,
    `*MATERIAL, NAME=MAT`,
    `*ELASTIC`,
    `${material.eMpa}, ${material.nu}`,
    `*SOLID SECTION, ELSET=PART, MATERIAL=MAT`,
    `*STEP`,
    `*STATIC`,
  );

  lines.push(`*BOUNDARY`);
  for (const name of options.fixed) {
    lines.push(`${name},1,3`);
  }

  lines.push(`*CLOAD`);
  for (const load of options.loads) {
    const nodes = options.nodesPerSet[load.selection];
    if (!nodes) {
      throw new SolveError(
        `Load references selection '${load.selection}' which has no nodes.`,
      );
    }
    // Per-node force: CalculiX *CLOAD is per node, the tool contract is total.
    for (const [axis, total] of load.totalForceN.entries()) {
      if (total !== 0) {
        lines.push(`${load.selection},${axis + 1},${total / nodes}`);
      }
    }
  }

  lines.push(
    `*NODE PRINT, NSET=NALL`,
    `U`,
    `*EL PRINT, ELSET=PART`,
    `S`,
    `*END STEP`,
    ``,
  );
  return lines.join("\n");
}

export interface SolveResult {
  maxDisplacement: {
    magnitudeMm: number;
    nodeId: number;
    vectorMm: [number, number, number];
  };
  maxVonMises: { mpa: number; elementId: number };
}

/** Parse the .dat: max displacement magnitude and max von Mises stress. */
export function parseDat(datText: string): SolveResult {
  let maxU = -1;
  let maxUNode = 0;
  let maxUVector: [number, number, number] = [0, 0, 0];
  let maxVm = -1;
  let maxVmElement = 0;

  let section: "u" | "s" | null = null;
  const numberPattern = /[-+]?\d+\.?\d*(?:E[-+]\d+)?/g;

  for (const line of datText.split("\n")) {
    if (line.includes("displacements")) {
      section = "u";
      continue;
    }
    if (line.includes("stresses")) {
      section = "s";
      continue;
    }
    if (!section) continue;

    const numbers = (line.match(numberPattern) ?? []).map(Number);

    if (section === "u" && numbers.length === 4) {
      const [node, vx, vy, vz] = numbers;
      const magnitude = Math.hypot(vx, vy, vz);
      if (magnitude > maxU) {
        maxU = magnitude;
        maxUNode = node;
        maxUVector = [vx, vy, vz];
      }
    } else if (section === "s" && numbers.length === 8) {
      const [element, , sxx, syy, szz, sxy, sxz, syz] = numbers;
      const vonMises = Math.sqrt(
        0.5 * ((sxx - syy) ** 2 + (syy - szz) ** 2 + (szz - sxx) ** 2) +
          3 * (sxy ** 2 + sxz ** 2 + syz ** 2),
      );
      if (vonMises > maxVm) {
        maxVm = vonMises;
        maxVmElement = element;
      }
    }
  }

  if (maxU < 0 || maxVm < 0) {
    throw new SolveError(
      "The .dat file contains no displacement or stress section — the " +
        "solve likely did not converge or produced no output. " +
        `.dat starts with: ${datText.slice(0, 200)}`,
    );
  }

  return {
    maxDisplacement: {
      magnitudeMm: maxU,
      nodeId: maxUNode,
      vectorMm: maxUVector,
    },
    maxVonMises: { mpa: maxVm, elementId: maxVmElement },
  };
}

/**
 * Run CalculiX on a deck in a private temporary directory, return raw .dat
 * text.  All subprocess management, timeout, and error surfacing live here;
 * parsers are separate pure functions.
 *
 * Private — callers use the typed wrappers below.
 */
interface CcxRawResult {
  datText: string;
  diagnostics: string;
}

async function runCcxRaw(
  deck: string,
  timeoutMs: number,
): Promise<CcxRawResult> {
  const workDir = await Deno.makeTempDir({ prefix: "calculix-solve-" });
  await Deno.writeTextFile(`${workDir}/job.inp`, deck);

  let child;
  try {
    child = new Deno.Command("ccx", {
      args: ["-i", "job"],
      cwd: workDir,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (e) {
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
    if (e instanceof Deno.errors.NotFound) throw new CcxNotFoundError();
    throw e;
  }

  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch { /* already exited */ }
  }, timeoutMs);
  const { success, stdout, stderr } = await child.output();
  clearTimeout(timer);

  try {
    const log = new TextDecoder().decode(stdout) +
      new TextDecoder().decode(stderr);
    if (!success || log.includes("*ERROR")) {
      const errorLines = log.split("\n").filter((l) => l.includes("ERROR"))
        .join("\n");
      throw new SolveError(
        `CalculiX failed${success ? "" : " (non-zero exit or timeout)"}: ${
          errorLines || log.slice(-800)
        }`,
      );
    }
    let datText;
    try {
      datText = await Deno.readTextFile(`${workDir}/job.dat`);
    } catch {
      throw new SolveError("CalculiX finished but wrote no .dat result file.");
    }
    return { datText, diagnostics: log };
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
  }
}

/** Run CalculiX on a deck and parse the static results. */
export async function solveDeck(
  deck: string,
  timeoutMs: number,
): Promise<SolveResult> {
  return parseDat((await runCcxRaw(deck, timeoutMs)).datText);
}

/**
 * Run a static deck while retaining the exact textual evidence emitted by
 * CalculiX.  The caller owns durable storage and is deliberately responsible
 * for deciding whether a result is publishable.
 */
export async function solveDeckRecorded(
  deck: string,
  timeoutMs: number,
): Promise<{ result: SolveResult; datText: string; diagnostics: string }> {
  const raw = await runCcxRaw(deck, timeoutMs);
  return {
    result: parseDat(raw.datText),
    datText: raw.datText,
    diagnostics: raw.diagnostics,
  };
}

// ── Modal (*FREQUENCY) ────────────────────────────────────────────────────────

/**
 * Format a floating-point value for the CalculiX input deck.
 *
 * CalculiX rejects lowercase-e scientific notation (e.g. "2.7e-9") and
 * requires uppercase E (e.g. "2.700000E-9").  Call this helper whenever a
 * number might be rendered in scientific notation by JavaScript's default
 * string conversion — particularly for very small values like mass density.
 */
function toCcxFloat(value: number): string {
  return value.toExponential(6).toUpperCase();
}

export interface ModalDeckOptions {
  /** Cleaned mesh from the gmsh bridge. */
  inpText: string;
  maxNodeId: number;
  material: Material;
  /**
   * Mass density in kg/m³ — REQUIRED for frequency analysis.
   * Converted internally to t/mm³ by the exact factor 1e-12:
   *   1 kg/m³ = (1e-3 t) / (1e9 mm³) = 1e-12 t/mm³.
   * There is no default — a density that looks like a value is not one.
   */
  densityKgM3: number;
  /** Selections whose nodes are fully fixed (all three translations). */
  fixed: string[];
  /**
   * Number of eigenfrequencies to compute, in [1, 30].
   * Must not exceed the free DOF count of the mesh (= 3 × unconstrained
   * nodes); requesting more modes than DOF causes ccx to return fewer.
   */
  nModes: number;
}

/** Build the complete CalculiX input deck for a *FREQUENCY analysis. */
export function buildModalDeck(options: ModalDeckOptions): string {
  const { material } = options;
  if (!(material.eMpa > 0) || !(material.nu > 0 && material.nu < 0.5)) {
    throw new SolveError(
      `Material out of range: e_mpa must be > 0 and nu in (0, 0.5), got ` +
        `e_mpa=${material.eMpa}, nu=${material.nu}.`,
    );
  }
  if (!(options.densityKgM3 > 0)) {
    throw new SolveError(
      `density_kg_m3 must be > 0, got ${options.densityKgM3}. ` +
        `Eigenfrequency analysis requires an explicit mass density — ` +
        `there is no default (Al 6061: 2700, steel: 7850).`,
    );
  }
  if (
    !Number.isInteger(options.nModes) ||
    options.nModes < 1 ||
    options.nModes > 30
  ) {
    throw new SolveError(
      `n_modes must be an integer in [1, 30], got ${options.nModes}.`,
    );
  }

  // 1 kg/m³ = 1e-12 t/mm³ (exact: 1 t = 1000 kg, 1 m³ = 1e9 mm³).
  // Writing the density with toCcxFloat is required: JavaScript renders
  // very small numbers with a lowercase-e exponent that CalculiX rejects.
  const densityTMm3 = options.densityKgM3 * 1e-12;

  const lines: string[] = [options.inpText.trimEnd()];
  lines.push(
    `*NSET, NSET=NALL, GENERATE`,
    `1, ${options.maxNodeId}`,
    `*MATERIAL, NAME=MAT`,
    `*ELASTIC`,
    `${material.eMpa}, ${material.nu}`,
    // *DENSITY must appear inside *MATERIAL before *SOLID SECTION.
    `*DENSITY`,
    toCcxFloat(densityTMm3),
    `*SOLID SECTION, ELSET=PART, MATERIAL=MAT`,
    `*STEP`,
    `*FREQUENCY`,
    `${options.nModes}`,
    `*BOUNDARY`,
  );
  for (const name of options.fixed) {
    lines.push(`${name},1,3`);
  }
  lines.push(
    `*NODE PRINT, NSET=NALL`,
    `U`,
    `*END STEP`,
    ``,
  );
  return lines.join("\n");
}

export interface ModalResult {
  /** Eigenfrequencies in ascending order (ccx returns them sorted), in Hz. */
  frequenciesHz: number[];
}

/**
 * Parse the *FREQUENCY .dat output.
 *
 * The eigenvalue output section header is letter-spaced:
 *   "E I G E N V A L U E   O U T P U T"
 *
 * Each data row has five columns (0-based):
 *   0: mode number
 *   1: eigenvalue λ (rad²/s²)
 *   2: angular frequency ω (rad/s)
 *   3: frequency f (Hz) — CYCLES/TIME column
 *   4: imaginary part of ω (zero for real eigenvalues)
 *
 * Column 3 (f in Hz) is what this function returns.  Verification:
 *   f_hz = ω_rad_s / (2π)
 * A parser that reads column 2 instead of 3 silently returns rad/s values
 * mislabelled as Hz — 2π× too large.
 */
export function parseModalDat(datText: string): ModalResult {
  const frequenciesHz: number[] = [];
  let inSection = false;
  const numberPattern = /[-+]?\d+\.?\d*(?:E[-+]\d+)?/g;

  for (const line of datText.split("\n")) {
    // The exact header is space-padded: "E I G E N V A L U E   O U T P U T".
    // "E I G E N V A L U E    N U M B E R" (per-mode shape sections) also
    // contains "E I G E N V A L U E" but does NOT contain "O U T P U T".
    if (line.includes("E I G E N V A L U E") && line.includes("O U T P U T")) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;

    // The eigenvalue table is followed by PARTICIPATION FACTORS, EFFECTIVE
    // MODAL MASS, TOTAL EFFECTIVE MASS — stop before any of them.
    if (
      line.includes("P A R T I C I P A T I O N") ||
      line.includes("E F F E C T I V E") ||
      line.includes("T O T A L")
    ) {
      break;
    }

    const numbers = (line.match(numberPattern) ?? []).map(Number);
    if (numbers.length === 5) {
      // numbers[3]: frequency in Hz (CYCLES/TIME column).
      frequenciesHz.push(numbers[3]);
    }
  }

  if (frequenciesHz.length === 0) {
    throw new SolveError(
      "The .dat file contains no eigenvalue output section — " +
        "the frequency solve likely did not converge or produced no output. " +
        `.dat starts with: ${datText.slice(0, 200)}`,
    );
  }

  return { frequenciesHz };
}

/** Run CalculiX on a modal deck and parse eigenfrequencies. */
export async function solveModalDeck(
  deck: string,
  timeoutMs: number,
): Promise<ModalResult> {
  return parseModalDat((await runCcxRaw(deck, timeoutMs)).datText);
}

// ── Buckling (*BUCKLE) ────────────────────────────────────────────────────────

export interface BuckleDeckOptions {
  /** Cleaned mesh from the gmsh bridge. */
  inpText: string;
  maxNodeId: number;
  material: Material;
  /** Selections whose nodes are fully fixed (all three translations). */
  fixed: string[];
  loads: NodalLoad[];
  /** Node count per set, to split total forces into per-node values. */
  nodesPerSet: Record<string, number>;
  /**
   * Number of buckling modes to compute, in [1, 30].
   * Mode 1 is the lowest (most critical) load factor.
   */
  nModes: number;
}

/**
 * Build the complete two-step CalculiX input deck for a *BUCKLE analysis.
 *
 * Step 1 (*STATIC) applies the reference loads and builds the geometric
 * (stress) stiffness matrix.  Step 2 (*BUCKLE) finds the eigenvalues λ_i
 * such that (K_elastic + λ_i·K_geometric)·U = 0.
 *
 * The critical load is: P_crit = load_factor × applied_load (from step 1).
 * A load_factor < 1 means the applied load already exceeds the critical load.
 */
export function buildBuckleDeck(options: BuckleDeckOptions): string {
  const { material } = options;
  if (!(material.eMpa > 0) || !(material.nu > 0 && material.nu < 0.5)) {
    throw new SolveError(
      `Material out of range: e_mpa must be > 0 and nu in (0, 0.5), got ` +
        `e_mpa=${material.eMpa}, nu=${material.nu}.`,
    );
  }
  if (
    !Number.isInteger(options.nModes) ||
    options.nModes < 1 ||
    options.nModes > 30
  ) {
    throw new SolveError(
      `n_modes must be an integer in [1, 30], got ${options.nModes}.`,
    );
  }

  // Shared *CLOAD lines — per-node forces derived from total forces.
  const cloadLines: string[] = [];
  for (const load of options.loads) {
    const nodes = options.nodesPerSet[load.selection];
    if (!nodes) {
      throw new SolveError(
        `Load references selection '${load.selection}' which has no nodes.`,
      );
    }
    for (const [axis, total] of load.totalForceN.entries()) {
      if (total !== 0) {
        cloadLines.push(`${load.selection},${axis + 1},${total / nodes}`);
      }
    }
  }

  // Shared *BOUNDARY lines.
  const boundaryLines = options.fixed.map((name) => `${name},1,3`);

  const lines: string[] = [options.inpText.trimEnd()];
  lines.push(
    `*NSET, NSET=NALL, GENERATE`,
    `1, ${options.maxNodeId}`,
    `*MATERIAL, NAME=MAT`,
    `*ELASTIC`,
    `${material.eMpa}, ${material.nu}`,
    `*SOLID SECTION, ELSET=PART, MATERIAL=MAT`,
    // Step 1: static preload — builds the geometric stiffness matrix.
    `*STEP`,
    `*STATIC`,
    `*BOUNDARY`,
    ...boundaryLines,
    `*CLOAD`,
    ...cloadLines,
    `*END STEP`,
    // Step 2: buckling eigensolver.
    // The same boundary conditions and loads define the reference state.
    `*STEP`,
    `*BUCKLE`,
    `${options.nModes}`,
    `*BOUNDARY`,
    ...boundaryLines,
    `*CLOAD`,
    ...cloadLines,
    `*NODE PRINT, NSET=NALL`,
    `U`,
    `*END STEP`,
    ``,
  );
  return lines.join("\n");
}

export interface BuckleResult {
  /**
   * Critical load factors in ascending order (mode 1 is the lowest).
   * P_critical = load_factor × applied_load.
   * A factor < 1 means the applied load already exceeds the critical load.
   */
  loadFactors: number[];
}

/**
 * Parse the *BUCKLE .dat output.
 *
 * The buckling factor section header is letter-spaced:
 *   "B U C K L I N G   F A C T O R   O U T P U T"
 *
 * Each data row has exactly two columns:
 *   0: mode number
 *   1: buckling load factor
 *
 * The section ends when the per-mode displacement sections begin
 * ("E I G E N V A L U E    N U M B E R").
 */
export function parseBuckleDat(datText: string): BuckleResult {
  const loadFactors: number[] = [];
  let inSection = false;
  const numberPattern = /[-+]?\d+\.?\d*(?:E[-+]\d+)?/g;

  for (const line of datText.split("\n")) {
    if (
      line.includes("B U C K L I N G") &&
      line.includes("F A C T O R") &&
      line.includes("O U T P U T")
    ) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;

    // Per-mode eigenvector displacement sections start here — stop.
    if (line.includes("E I G E N V A L U E    N U M B E R")) {
      break;
    }

    const numbers = (line.match(numberPattern) ?? []).map(Number);
    if (numbers.length === 2) {
      // numbers[0] is the mode index, numbers[1] is the load factor.
      loadFactors.push(numbers[1]);
    }
  }

  if (loadFactors.length === 0) {
    throw new SolveError(
      "The .dat file contains no buckling factor output section — " +
        "the buckle solve likely did not converge or produced no output. " +
        `.dat starts with: ${datText.slice(0, 200)}`,
    );
  }

  return { loadFactors };
}

/** Run CalculiX on a buckling deck and parse critical load factors. */
export async function solveBuckleDeck(
  deck: string,
  timeoutMs: number,
): Promise<BuckleResult> {
  return parseBuckleDat((await runCcxRaw(deck, timeoutMs)).datText);
}

// ── Creep (*VISCO + Norton law) ───────────────────────────────────────────────

export interface CreepDeckOptions {
  /** Cleaned mesh from the gmsh bridge. */
  inpText: string;
  maxNodeId: number;
  material: Material;
  /** Selections whose nodes are fully fixed (all three translations). */
  fixed: string[];
  loads: NodalLoad[];
  /** Node count per set, to split total forces into per-node values. */
  nodesPerSet: Record<string, number>;
  /**
   * Norton creep law coefficient A.
   * Units: MPa^(-norton_n) · s^(-1), in the mm/N/MPa/t/s system.
   * A value correct in SI (Pa^(-n) · s^(-1)) is off by 10^(6n) — for n=3
   * that is 10^18. The caller must supply A in MPa units, not SI.
   */
  nortonA: number;
  /**
   * Norton creep exponent n (dimensionless, typically 2–8).
   * Creep strain rate = A · σ^n.
   */
  nortonN: number;
  /** Total creep duration in seconds. */
  durationS: number;
  /**
   * Initial time increment in seconds.  CalculiX may reduce it if the creep
   * strain tolerance CETOL is exceeded.  A reasonable choice is 1/10 of the
   * total duration.
   */
  initialTimeDtS: number;
}

/**
 * Build the complete CalculiX input deck for a *VISCO creep analysis.
 *
 * The Norton power law  ε̇ = A · σⁿ  is specified under *CREEP, LAW=NORTON.
 * The *VISCO card controls the creep-strain time integrator; CETOL=1e-4 is
 * a sensible default (maximum creep strain increment per step).
 *
 * Increment line: initial_dt, total_t, min_dt, max_dt.
 * min_dt = initial_dt / 100 (allows up to 100× refinement).
 * max_dt = duration_s (CalculiX caps to remaining time automatically).
 *
 * NOTE: this is time-dependent creep under constant load, not stress
 * relaxation (which requires prescribed displacement and no *CLOAD).
 */
export function buildCreepDeck(options: CreepDeckOptions): string {
  const { material } = options;
  if (!(material.eMpa > 0) || !(material.nu > 0 && material.nu < 0.5)) {
    throw new SolveError(
      `Material out of range: e_mpa must be > 0 and nu in (0, 0.5), got ` +
        `e_mpa=${material.eMpa}, nu=${material.nu}.`,
    );
  }
  if (!(options.nortonA > 0)) {
    throw new SolveError(
      `norton_a must be > 0, got ${options.nortonA}. ` +
        `Units: MPa^(-norton_n) s^(-1) in the mm/N/MPa/s system. ` +
        `A value in SI Pa units is off by factor 10^(6n).`,
    );
  }
  if (!(options.nortonN > 0)) {
    throw new SolveError(
      `norton_n must be > 0, got ${options.nortonN}.`,
    );
  }
  if (!(options.durationS > 0)) {
    throw new SolveError(
      `duration_s must be > 0, got ${options.durationS}.`,
    );
  }
  if (
    !(options.initialTimeDtS > 0 && options.initialTimeDtS <= options.durationS)
  ) {
    throw new SolveError(
      `initial_time_increment_s must be in (0, duration_s], got ` +
        `${options.initialTimeDtS} vs duration=${options.durationS}.`,
    );
  }

  const cetol = 1e-4;
  const minDt = options.initialTimeDtS / 100;
  const maxDt = options.durationS;

  const lines: string[] = [options.inpText.trimEnd()];
  lines.push(
    `*NSET, NSET=NALL, GENERATE`,
    `1, ${options.maxNodeId}`,
    `*MATERIAL, NAME=MAT`,
    `*ELASTIC`,
    `${material.eMpa}, ${material.nu}`,
    // *CREEP must appear inside *MATERIAL, before *SOLID SECTION.
    // A is in MPa^(-n) s^(-1); the third field is 0 (temperature exponent).
    `*CREEP, LAW=NORTON`,
    `${options.nortonA}, ${options.nortonN}, 0`,
    `*SOLID SECTION, ELSET=PART, MATERIAL=MAT`,
    `*STEP`,
    // CETOL: maximum allowable creep strain increment per time step.
    `*VISCO, CETOL=${cetol}`,
    `${options.initialTimeDtS}, ${options.durationS}, ${minDt}, ${maxDt}`,
    `*BOUNDARY`,
  );
  for (const name of options.fixed) {
    lines.push(`${name},1,3`);
  }

  lines.push(`*CLOAD`);
  for (const load of options.loads) {
    const nodes = options.nodesPerSet[load.selection];
    if (!nodes) {
      throw new SolveError(
        `Load references selection '${load.selection}' which has no nodes.`,
      );
    }
    for (const [axis, total] of load.totalForceN.entries()) {
      if (total !== 0) {
        lines.push(`${load.selection},${axis + 1},${total / nodes}`);
      }
    }
  }

  lines.push(
    `*NODE PRINT, NSET=NALL`,
    `U`,
    `*EL PRINT, ELSET=PART`,
    `S`,
    `*END STEP`,
    ``,
  );
  return lines.join("\n");
}

/**
 * Parse only the last INCREMENT block of a *VISCO .dat file.
 *
 * A *VISCO analysis writes one displacement and one stress section per
 * converged increment.  `parseDat` returns the global maximum over ALL
 * increments, which equals the final state only if displacement grows
 * monotonically (true for constant load, but not for relaxation).
 *
 * This function locates the last "INCREMENT" header and passes only its
 * trailing text to `parseDat`, ensuring the result reflects the end state
 * regardless of the loading history. It does not parse the printed time.
 */
export function parseDatLastIncrement(datText: string): SolveResult {
  return parseDat(lastIncrementTrailingText(datText));
}

export interface LastIncrementResult extends SolveResult {
  /** Printed time of the final converged displacement/stress sections, in s. */
  observedTimeS: number;
}

/** CalculiX prints times in Fortran scientific format (~7 significant digits). */
export const CREEP_TIME_PRINT_RELATIVE_TOLERANCE = 1e-6;
export const CREEP_TIME_PRINT_ABSOLUTE_TOLERANCE = 1e-9;

/**
 * Parse the last INCREMENT block and the printed times of its final
 * displacement and stress sections. Missing or disagreeing times fail.
 */
export function parseDatLastIncrementObserved(
  datText: string,
): LastIncrementResult {
  const block = lastIncrementTrailingText(datText);
  const result = parseDat(block);
  const displacementTime = parseSectionTime(block, "displacements");
  const stressTime = parseSectionTime(block, "stresses");
  if (displacementTime === undefined || stressTime === undefined) {
    throw new SolveError(
      "The final INCREMENT is missing a displacement or stress time.",
    );
  }
  if (!creepPrintedTimesAgree(displacementTime, stressTime)) {
    throw new SolveError(
      `Final increment displacement time ${displacementTime} s does not ` +
        `match stress time ${stressTime} s.`,
    );
  }
  return { ...result, observedTimeS: displacementTime };
}

export function creepPrintedTimesAgree(
  left: number,
  right: number,
): boolean {
  const scale = Math.max(
    Math.abs(left),
    Math.abs(right),
    CREEP_TIME_PRINT_ABSOLUTE_TOLERANCE,
  );
  return Math.abs(left - right) <= Math.max(
    CREEP_TIME_PRINT_RELATIVE_TOLERANCE * scale,
    CREEP_TIME_PRINT_ABSOLUTE_TOLERANCE,
  );
}

export function formatObservedTimeS(value: number): string {
  if (!Number.isFinite(value)) {
    throw new SolveError(`observed time is not finite: ${value}`);
  }
  if (Number.isInteger(value)) return String(value);
  const compact = Number(value.toPrecision(7));
  if (Number.isInteger(compact)) return String(compact);
  return String(compact);
}

export function assertCreepReachedRequestedDuration(
  observedTimeS: number,
  requestedDurationS: number,
): void {
  if (!Number.isFinite(observedTimeS) || observedTimeS < 0) {
    throw new SolveError(
      `Creep observed final time is invalid: ${observedTimeS}.`,
    );
  }
  if (!Number.isFinite(requestedDurationS) || requestedDurationS <= 0) {
    throw new SolveError(
      `duration_s must be > 0, got ${requestedDurationS}.`,
    );
  }
  const tolerance = Math.max(
    CREEP_TIME_PRINT_RELATIVE_TOLERANCE * requestedDurationS,
    CREEP_TIME_PRINT_ABSOLUTE_TOLERANCE,
  );
  if (observedTimeS + tolerance < requestedDurationS) {
    throw new SolveError(
      `Creep solve stopped at observed t=${
        formatObservedTimeS(observedTimeS)
      } s before requested duration_s=${requestedDurationS} s.`,
    );
  }
}

function lastIncrementTrailingText(datText: string): string {
  const lines = datText.split("\n");
  let lastIncrIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes("INCREMENT")) {
      lastIncrIdx = i;
      break;
    }
  }
  if (lastIncrIdx < 0) {
    throw new SolveError(
      "The .dat file contains no INCREMENT block — " +
        "the *VISCO solve likely did not converge or produced no output. " +
        `.dat starts with: ${datText.slice(0, 200)}`,
    );
  }
  return lines.slice(lastIncrIdx + 1).join("\n");
}

function parseSectionTime(
  text: string,
  kind: "displacements" | "stresses",
): number | undefined {
  let found: number | undefined;
  for (const line of text.split("\n")) {
    if (!line.includes(kind) || !line.includes("and time")) continue;
    const match = line.match(
      /and time\s+([-+]?(?:\d+\.?\d*|\.\d+)(?:[EeDd][-+]?\d+)?)/,
    );
    if (!match) continue;
    const value = Number(match[1].replace(/[Dd]/, "E"));
    if (!Number.isFinite(value)) continue;
    found = value;
  }
  return found;
}

/** Run CalculiX on a creep deck and parse the last-increment state. */
export async function solveCreepDeck(
  deck: string,
  timeoutMs: number,
): Promise<LastIncrementResult> {
  return parseDatLastIncrementObserved(
    (await runCcxRaw(deck, timeoutMs)).datText,
  );
}

// ── Coupled temperature-displacement (*COUPLED TEMPERATURE-DISPLACEMENT) ──────

export interface ThermalBC {
  /** Name of the face selection whose nodes receive this temperature. */
  selection: string;
  /** Temperature in °C applied to all nodes of the selection. */
  temperatureC: number;
}

export interface CoupledThermalDeckOptions {
  /** Cleaned mesh from the gmsh bridge. */
  inpText: string;
  maxNodeId: number;
  material: Material;
  /**
   * Thermal conductivity in W/(m·K).
   *
   * Conversion identity: 1 W/(m·K) = 1 mW/(mm·K).
   * Proof: W/(m·K) × (1000 mW/W) × (1 m / 1000 mm) = mW/(mm·K); factors cancel.
   * The value is written as-is into *CONDUCTIVITY — no multiplication needed.
   */
  conductivityWmK: number;
  /** Linear thermal expansion coefficient in 1/K (isotropic). */
  expansionPerK: number;
  /**
   * Reference temperature in °C for zero thermal strain.
   * Applied as *INITIAL CONDITIONS, TYPE=TEMPERATURE — required by ccx.
   */
  referenceTemperatureC: number;
  /** Selections whose nodes are fully fixed (all three mechanical translations). */
  fixed: string[];
  /**
   * Temperature boundary conditions on named selections.
   * DOF 11 = temperature in CalculiX.  A selection can be in both
   * thermalBCs and fixed (thermal + mechanical BCs are independent DOFs).
   */
  thermalBCs: ThermalBC[];
  /** Optional mechanical loads (total force per selection, same as static). */
  loads: NodalLoad[];
  nodesPerSet: Record<string, number>;
}

export interface CoupledThermalResult {
  /** Maximum nodal temperature in °C across all nodes and the steady state. */
  maxTemperatureC: number;
  /** Maximum displacement magnitude in mm (thermal expansion + mechanical). */
  maxDisplacement: {
    magnitudeMm: number;
    nodeId: number;
    vectorMm: [number, number, number];
  };
  /** Maximum von Mises stress in MPa (thermal + mechanical). */
  maxVonMises: { mpa: number; elementId: number };
}

/**
 * Build the complete CalculiX input deck for a steady-state
 * *COUPLED TEMPERATURE-DISPLACEMENT analysis.
 *
 * Analysis type: STEADY STATE (no transient response).
 * Steady state does not require *SPECIFIC HEAT; adding it for a steady-state
 * analysis is harmless but misleading — it is omitted intentionally.
 * If transient coupled analysis is added in the future, *SPECIFIC HEAT becomes
 * mandatory.
 *
 * Element type: C3D4/C3D10 from Gmsh — ccx automatically adds the thermal
 * temperature DOF (11).  C3D8T-style element names are not supported in
 * ccx 2.21 and must not be specified in the deck.
 *
 * Thermal BCs are applied as *BOUNDARY selection,11,11,T_value (DOF 11).
 * A selection can simultaneously have mechanical (1,3) and thermal (11) BCs.
 */
export function buildCoupledThermalDeck(
  options: CoupledThermalDeckOptions,
): string {
  const { material } = options;
  if (!(material.eMpa > 0) || !(material.nu > 0 && material.nu < 0.5)) {
    throw new SolveError(
      `Material out of range: e_mpa must be > 0 and nu in (0, 0.5), got ` +
        `e_mpa=${material.eMpa}, nu=${material.nu}.`,
    );
  }
  if (!(options.conductivityWmK > 0)) {
    throw new SolveError(
      `conductivity_w_mk must be > 0, got ${options.conductivityWmK}. ` +
        `Al 6061: 167, steel: 50.`,
    );
  }
  if (!(options.expansionPerK > 0)) {
    throw new SolveError(
      `expansion_per_k must be > 0, got ${options.expansionPerK}. ` +
        `Al 6061: 23.6e-6, steel: 12e-6.`,
    );
  }
  if (options.thermalBCs.length === 0) {
    throw new SolveError(
      `thermal_bcs must have at least one entry — ` +
        `a coupled analysis without any temperature BC is degenerate.`,
    );
  }

  // Reject duplicate thermal BCs on the same selection.
  const thermalNames = options.thermalBCs.map((bc) => bc.selection);
  const thermalDups = thermalNames.filter(
    (n, i) => thermalNames.indexOf(n) !== i,
  );
  if (thermalDups.length > 0) {
    throw new SolveError(
      `thermal_bcs has duplicate selection(s): ${thermalDups.join(", ")}. ` +
        `Each selection may carry only one temperature BC.`,
    );
  }

  // Shared *CLOAD lines for mechanical loads.
  const cloadLines: string[] = [];
  for (const load of options.loads) {
    const nodes = options.nodesPerSet[load.selection];
    if (!nodes) {
      throw new SolveError(
        `Load references selection '${load.selection}' which has no nodes.`,
      );
    }
    for (const [axis, total] of load.totalForceN.entries()) {
      if (total !== 0) {
        cloadLines.push(`${load.selection},${axis + 1},${total / nodes}`);
      }
    }
  }

  const lines: string[] = [options.inpText.trimEnd()];
  lines.push(
    `*NSET, NSET=NALL, GENERATE`,
    `1, ${options.maxNodeId}`,
    `*MATERIAL, NAME=MAT`,
    `*ELASTIC`,
    `${material.eMpa}, ${material.nu}`,
    // 1 W/(m·K) = 1 mW/(mm·K) exactly — the value is written as-is.
    `*CONDUCTIVITY`,
    `${options.conductivityWmK}`,
    `*EXPANSION, TYPE=ISO`,
    `${options.expansionPerK}`,
    `*SOLID SECTION, ELSET=PART, MATERIAL=MAT`,
    // *INITIAL CONDITIONS is required by ccx for any coupled thermal analysis.
    // It sets the reference temperature for zero thermal strain.
    `*INITIAL CONDITIONS, TYPE=TEMPERATURE`,
    `NALL, ${options.referenceTemperatureC}`,
    `*STEP`,
    `*COUPLED TEMPERATURE-DISPLACEMENT, STEADY STATE`,
    `*BOUNDARY`,
  );
  for (const name of options.fixed) {
    lines.push(`${name},1,3`);
  }
  for (const bc of options.thermalBCs) {
    // DOF 11 = temperature in CalculiX.
    lines.push(`${bc.selection},11,11,${bc.temperatureC}`);
  }

  if (cloadLines.length > 0) {
    lines.push(`*CLOAD`, ...cloadLines);
  }

  lines.push(
    `*NODE PRINT, NSET=NALL`,
    `NT`,
    `U`,
    `*EL PRINT, ELSET=PART`,
    `S`,
    `*END STEP`,
    ``,
  );
  return lines.join("\n");
}

/**
 * Parse the *COUPLED TEMPERATURE-DISPLACEMENT .dat output.
 *
 * The steady-state .dat has three sections per INCREMENT (only one for
 * steady-state):
 *   "temperatures for set NALL and time X"  — 2-column rows: node_id, T_°C
 *   "displacements (vx,vy,vz) for set NALL and time X" — 4-column rows
 *   "stresses (elem, integ.pnt.,...) for set PART and time X" — 8-column rows
 *
 * This function takes the maximum over all rows in all sections (there is only
 * one INCREMENT for steady state, so taking the global max is correct).
 */
export function parseCoupledThermalDat(datText: string): CoupledThermalResult {
  let maxTempC = -Infinity;
  let maxU = -1;
  let maxUNode = 0;
  let maxUVector: [number, number, number] = [0, 0, 0];
  let maxVm = -1;
  let maxVmElement = 0;

  let section: "temp" | "u" | "s" | null = null;
  const numberPattern = /[-+]?\d+\.?\d*(?:E[-+]\d+)?/g;

  for (const line of datText.split("\n")) {
    // Section detection — must check "temperatures" before "displacements"
    // even though they are disjoint; order makes the intent explicit.
    if (line.includes("temperatures")) {
      section = "temp";
      continue;
    }
    if (line.includes("displacements")) {
      section = "u";
      continue;
    }
    if (line.includes("stresses")) {
      section = "s";
      continue;
    }
    if (!section) continue;

    const numbers = (line.match(numberPattern) ?? []).map(Number);

    if (section === "temp" && numbers.length === 2) {
      // numbers[0]: node id, numbers[1]: temperature in °C.
      const temp = numbers[1];
      if (temp > maxTempC) maxTempC = temp;
    } else if (section === "u" && numbers.length === 4) {
      const [node, vx, vy, vz] = numbers;
      const magnitude = Math.hypot(vx, vy, vz);
      if (magnitude > maxU) {
        maxU = magnitude;
        maxUNode = node;
        maxUVector = [vx, vy, vz];
      }
    } else if (section === "s" && numbers.length === 8) {
      const [element, , sxx, syy, szz, sxy, sxz, syz] = numbers;
      const vonMises = Math.sqrt(
        0.5 * ((sxx - syy) ** 2 + (syy - szz) ** 2 + (szz - sxx) ** 2) +
          3 * (sxy ** 2 + sxz ** 2 + syz ** 2),
      );
      if (vonMises > maxVm) {
        maxVm = vonMises;
        maxVmElement = element;
      }
    }
  }

  if (maxTempC === -Infinity || maxU < 0 || maxVm < 0) {
    throw new SolveError(
      "The .dat file is missing temperature, displacement, or stress section — " +
        "the coupled thermal solve likely did not converge or produced no output. " +
        `.dat starts with: ${datText.slice(0, 200)}`,
    );
  }

  return {
    maxTemperatureC: maxTempC,
    maxDisplacement: {
      magnitudeMm: maxU,
      nodeId: maxUNode,
      vectorMm: maxUVector,
    },
    maxVonMises: { mpa: maxVm, elementId: maxVmElement },
  };
}

/** Run CalculiX on a coupled thermal deck and parse results. */
export async function solveCoupledThermalDeck(
  deck: string,
  timeoutMs: number,
): Promise<CoupledThermalResult> {
  return parseCoupledThermalDat((await runCcxRaw(deck, timeoutMs)).datText);
}
