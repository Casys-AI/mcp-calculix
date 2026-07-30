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
  maxDisplacement: { magnitudeMm: number; nodeId: number; vectorMm: [number, number, number] };
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
    maxDisplacement: { magnitudeMm: maxU, nodeId: maxUNode, vectorMm: maxUVector },
    maxVonMises: { mpa: maxVm, elementId: maxVmElement },
  };
}

/** Run CalculiX on a deck and parse the results. */
export async function solveDeck(deck: string, timeoutMs: number): Promise<SolveResult> {
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
    const log = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);
    if (!success || log.includes("*ERROR")) {
      const errorLines = log.split("\n").filter((l) => l.includes("ERROR")).join("\n");
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
    return parseDat(datText);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
  }
}
