/**
 * Generates tests/fixtures/bracket_thermal.dat using real ccx in the container.
 * Run from /tmp/mcp-calculix-dev inside the container:
 *   deno run --allow-all scripts/gen_thermal_fixture.ts
 *
 * Steady-state coupled temperature-displacement analysis on bracket.step:
 *   - FIXED face: clamped + cold (20°C)
 *   - LOADED face: hot (200°C), no mechanical load
 *   - Al 6061: E=70000 MPa, nu=0.33, conductivity=167 W/(m·K), alpha=23.6e-6/K
 *
 * 1 W/(m·K) = 1 mW/(mm·K) exactly (factors of 1000 cancel),
 * so conductivity_w_mk value is written directly into *CONDUCTIVITY.
 *
 * Element type: C3D8/C3D10 from gmsh — ccx handles thermal DOF automatically.
 * *SPECIFIC HEAT is NOT needed for steady-state.
 */

import { meshStep } from "../src/api/gmsh.ts";

const BRACKET_STEP = new URL(
  "../tests/fixtures/bracket.step",
  import.meta.url,
).pathname;
const OUT_DAT = new URL(
  "../tests/fixtures/bracket_thermal.dat",
  import.meta.url,
).pathname;

console.log("meshing bracket.step (8 mm linear tets)...");
const mesh = await meshStep({
  stepPath: BRACKET_STEP,
  selections: [
    { name: "FIXED", box: { min: [-31, -21, -3.1], max: [31, 21, -2.4] } },
    { name: "LOADED", box: { min: [-31, -21, 49.4], max: [-24, 21, 50.1] } },
  ],
  meshSizeMm: 8,
  elementOrder: 1,
  timeoutMs: 120_000,
});
console.log(
  `mesh: ${mesh.nodeCount} nodes, ${mesh.elementCount} elements`,
  `FIXED=${mesh.nodesPerSet["FIXED"]} LOADED=${mesh.nodesPerSet["LOADED"]}`,
);

const conductivityWmK = 167; // W/(m·K) = mW/(mm·K) exactly
const expansionPerK = 23.6e-6; // /K, Al 6061
const refTempC = 20; // °C
const tColdC = 20; // °C — FIXED face
const tHotC = 200; // °C — LOADED face

const lines: string[] = [mesh.inpText.trimEnd()];
lines.push(
  `*NSET, NSET=NALL, GENERATE`,
  `1, ${mesh.maxNodeId}`,
  `*MATERIAL, NAME=MAT`,
  `*ELASTIC`,
  `70000, 0.33`,
  `*CONDUCTIVITY`,
  `${conductivityWmK}`,
  `*EXPANSION, TYPE=ISO`,
  `${expansionPerK}`,
  `*SOLID SECTION, ELSET=PART, MATERIAL=MAT`,
  // *INITIAL CONDITIONS is required by ccx for coupled thermal analysis.
  `*INITIAL CONDITIONS, TYPE=TEMPERATURE`,
  `NALL, ${refTempC}`,
  `*STEP`,
  `*COUPLED TEMPERATURE-DISPLACEMENT, STEADY STATE`,
  `*BOUNDARY`,
  `FIXED,1,3`,
  // Thermal BCs: DOF 11 = temperature.
  `FIXED,11,11,${tColdC}`,
  `LOADED,11,11,${tHotC}`,
  `*NODE PRINT, NSET=NALL`,
  `NT`,
  `U`,
  `*EL PRINT, ELSET=PART`,
  `S`,
  `*END STEP`,
  ``,
);
const deck = lines.join("\n");

const workDir = await Deno.makeTempDir({ prefix: "thermal-fix-" });
await Deno.writeTextFile(`${workDir}/job.inp`, deck);
console.log("running ccx...");
const cmd = new Deno.Command("ccx", {
  args: ["-i", "job"],
  cwd: workDir,
  stdout: "piped",
  stderr: "piped",
});
const { success, stdout, stderr } = await cmd.output();
const log = new TextDecoder().decode(stdout) +
  new TextDecoder().decode(stderr);
console.log("ccx success:", success);
if (!success || log.includes("*ERROR")) {
  console.error("CCX ERROR OUTPUT:");
  console.error(log.slice(-3000));
  Deno.exit(1);
}

const datText = await Deno.readTextFile(`${workDir}/job.dat`);
await Deno.writeTextFile(OUT_DAT, datText);
console.log("written:", OUT_DAT);

// Show section headers
const datLines = datText.split("\n");
const keyLines = datLines.filter((l) =>
  l.includes("temperature") || l.includes("displace") ||
  l.includes("stress") || l.trim().match(/^\d+\s+[-+]?\d/)
);
console.log("--- key lines in .dat (section headers + first data rows) ---");
keyLines.slice(0, 30).forEach((l) => console.log(l));
console.log("--- dat head (first 800 chars) ---");
console.log(datText.slice(0, 800));

await Deno.remove(workDir, { recursive: true }).catch(() => {});
