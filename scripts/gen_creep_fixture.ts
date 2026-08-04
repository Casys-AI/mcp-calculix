/**
 * Generates tests/fixtures/bracket_creep.dat using real ccx in the container.
 * Run from /tmp/mcp-calculix-dev inside the container:
 *   deno run --allow-all scripts/gen_creep_fixture.ts
 *
 * Norton parameters chosen so the analysis converges quickly on the bracket:
 *   A = 1e-10 MPa^(-3) s^(-1), n = 3, duration = 100 s.
 * The physical material belongs to the caller; these are fixture parameters only.
 */

import { meshStep } from "../src/api/gmsh.ts";

const BRACKET_STEP = new URL(
  "../tests/fixtures/bracket.step",
  import.meta.url,
).pathname;
const OUT_DAT = new URL(
  "../tests/fixtures/bracket_creep.dat",
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

const A = 1e-10; // MPa^(-3) s^(-1)
const n = 3;
const duration = 100; // s
const initialDt = 10;
const minDt = 1;
const maxDt = 20;
const cetol = 1e-4;
const forcePerNode = 500 / mesh.nodesPerSet["LOADED"];

const lines: string[] = [mesh.inpText.trimEnd()];
lines.push(
  `*NSET, NSET=NALL, GENERATE`,
  `1, ${mesh.maxNodeId}`,
  `*MATERIAL, NAME=MAT`,
  `*ELASTIC`,
  `70000, 0.33`,
  `*CREEP, LAW=NORTON`,
  `${A}, ${n}, 0`,
  `*SOLID SECTION, ELSET=PART, MATERIAL=MAT`,
  `*STEP`,
  `*VISCO, CETOL=${cetol}`,
  `${initialDt}, ${duration}, ${minDt}, ${maxDt}`,
  `*BOUNDARY`,
  `FIXED,1,3`,
  `*CLOAD`,
  `LOADED,3,${-forcePerNode}`,
  `*NODE PRINT, NSET=NALL`,
  `U`,
  `*EL PRINT, ELSET=PART`,
  `S`,
  `*END STEP`,
  ``,
);
const deck = lines.join("\n");

const workDir = await Deno.makeTempDir({ prefix: "creep-fix-" });
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

// Show INCREMENT blocks summary
const datLines = datText.split("\n");
const incrLines = datLines.filter((l) =>
  l.includes("INCREMENT") || l.includes("displacements") ||
  l.includes("stresses")
);
console.log("--- key lines in .dat ---");
incrLines.slice(0, 30).forEach((l) => console.log(l));
console.log("--- dat tail (last 300 chars) ---");
console.log(datText.slice(-300));

await Deno.remove(workDir, { recursive: true }).catch(() => {});
