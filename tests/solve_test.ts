/**
 * CalculiX tool tests — need gmsh and ccx on PATH (installed in CI).
 *
 * The integration test replays the validated spike: the build123d bracket
 * under 500 N, expected to hold with a wide margin against Al 6061 yield.
 */

import { assertAlmostEquals, assertEquals, assertRejects } from "@std/assert";
import { solveTools } from "../src/tools/solve.ts";
import { buildDeck, parseDat, SolveError } from "../src/api/ccx.ts";
import { buildGeoScript, cleanInp, MeshingError, validateSetName } from "../src/api/gmsh.ts";

const BRACKET_STEP = new URL("./fixtures/bracket.step", import.meta.url).pathname;

function getHandler(name: string) {
  const tool = solveTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.handler;
}

/** The bracket case from the spike: base fixed, 500 N down on the wing top. */
const BRACKET_CASE = {
  step_path: BRACKET_STEP,
  mesh_size_mm: 4,
  material: { e_mpa: 70000, nu: 0.33 },
  selections: [
    { name: "FIXED", box: { min: [-31, -21, -3.1], max: [31, 21, -2.4] } },
    { name: "LOADED", box: { min: [-31, -21, 49.4], max: [-24, 21, 50.1] } },
  ],
  fixed: ["FIXED"],
  loads: [{ selection: "LOADED", force_n: [0, 0, -500] }],
};

// ── Integration: the full pipeline ──────────────────────────────────────────

Deno.test("calculix_solve_static - bracket under 500 N: plausible stress and displacement", async () => {
  const result = await getHandler("calculix_solve_static")(
    structuredClone(BRACKET_CASE),
  ) as Record<string, unknown>;

  const mesh = result.mesh as { nodes: number; nodesPerSelection: Record<string, number> };
  assertEquals(mesh.nodes > 1000, true);
  assertEquals(mesh.nodesPerSelection.FIXED > 0, true);
  assertEquals(mesh.nodesPerSelection.LOADED > 0, true);

  // Spike reference (mesh 3 mm): 26.6 MPa / 0.043 mm. A coarser 4 mm mesh
  // shifts values, but the order of magnitude is pinned: the bracket holds
  // (< 240 MPa yield) and visibly deflects (> 1 µm).
  const vm = result.max_von_mises_mpa as number;
  const u = result.max_displacement_mm as number;
  assertEquals(vm > 5 && vm < 240, true, `von Mises out of plausible range: ${vm} MPa`);
  assertEquals(u > 0.001 && u < 1, true, `displacement out of plausible range: ${u} mm`);
});

Deno.test("calculix_solve_static - a selection matching no surface names itself", async () => {
  const badCase = structuredClone(BRACKET_CASE);
  badCase.selections[1] = {
    name: "LOADED",
    box: { min: [500, 500, 500], max: [501, 501, 501] }, // nowhere near the part
  };

  await assertRejects(
    async () => await getHandler("calculix_solve_static")(badCase),
    MeshingError,
    "'LOADED' matched no surface",
  );
});

Deno.test("calculix_solve_static - referencing an undeclared selection fails before any subprocess", async () => {
  const badCase = structuredClone(BRACKET_CASE);
  badCase.fixed = ["NOT_DECLARED"];

  await assertRejects(
    async () => await getHandler("calculix_solve_static")(badCase),
    Error,
    "NOT_DECLARED",
  );
});

Deno.test("calculix_solve_static - a selection both fixed and loaded is rejected", async () => {
  const badCase = structuredClone(BRACKET_CASE);
  badCase.loads = [{ selection: "FIXED", force_n: [0, 0, -500] }];

  await assertRejects(
    async () => await getHandler("calculix_solve_static")(badCase),
    Error,
    "both fixed and loaded",
  );
});

// ── Unit: pure text stages ──────────────────────────────────────────────────

Deno.test("buildGeoScript - selections become physical surfaces with bounding boxes", () => {
  const geo = buildGeoScript({
    stepPath: "/tmp/part.step",
    selections: [{ name: "BASE", box: { min: [0, 0, 0], max: [1, 1, 1] } }],
    meshSizeMm: 3,
    elementOrder: 2,
    timeoutMs: 1000,
  });

  assertEquals(geo.includes(`Merge "/tmp/part.step";`), true);
  assertEquals(geo.includes("Surface In BoundingBox{0, 0, 0, 1, 1, 1}"), true);
  assertEquals(geo.includes(`Physical Surface("BASE")`), true);
  assertEquals(geo.includes("Mesh.SaveGroupsOfNodes = 1;"), true);
});

Deno.test("buildGeoScript - an inverted box is rejected with both corners shown", () => {
  assertRejects; // (sync throw, not a rejection)
  let thrown = "";
  try {
    buildGeoScript({
      stepPath: "/tmp/part.step",
      selections: [{ name: "BAD", box: { min: [1, 0, 0], max: [0, 1, 1] } }],
      meshSizeMm: 3,
      elementOrder: 2,
      timeoutMs: 1000,
    });
  } catch (e) {
    thrown = (e as Error).message;
  }
  assertEquals(thrown.includes("strictly below"), true);
});

Deno.test("validateSetName - rejects names that would corrupt the deck", () => {
  let thrown = "";
  try {
    validateSetName("BAD NAME, *BOUNDARY");
  } catch (e) {
    thrown = (e as Error).message;
  }
  assertEquals(thrown.includes("invalid"), true);
});

Deno.test("cleanInp - surface elements go, volume elements and node sets stay", () => {
  const raw = [
    "*NODE",
    "1, 0, 0, 0",
    "*ELEMENT, type=CPS6, ELSET=Surface1",
    "10, 1, 2, 3, 4, 5, 6",
    "*ELEMENT, type=C3D10, ELSET=Volume1",
    "20, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10",
    "*NSET,NSET=FIXED",
    "1, 2, 3",
  ].join("\n");

  const cleaned = cleanInp(raw);
  assertEquals(cleaned.includes("CPS6"), false);
  assertEquals(cleaned.includes("C3D10"), true);
  assertEquals(cleaned.includes("NSET=FIXED"), true);
});

Deno.test("buildDeck - generates NALL, splits total force per node, rejects bad material", () => {
  const deck = buildDeck({
    inpText: "*NODE\n1, 0, 0, 0",
    maxNodeId: 100,
    material: { eMpa: 70000, nu: 0.33 },
    fixed: ["FIXED"],
    loads: [{ selection: "LOADED", totalForceN: [0, 0, -500] }],
    nodesPerSet: { FIXED: 10, LOADED: 50 },
  });

  assertEquals(deck.includes("*NSET, NSET=NALL, GENERATE"), true);
  assertEquals(deck.includes("1, 100"), true);
  assertEquals(deck.includes("LOADED,3,-10"), true); // 500 N / 50 nodes
  assertEquals(deck.includes("FIXED,1,3"), true);

  let thrown = "";
  try {
    buildDeck({
      inpText: "",
      maxNodeId: 1,
      material: { eMpa: -1, nu: 0.33 },
      fixed: [],
      loads: [],
      nodesPerSet: {},
    });
  } catch (e) {
    thrown = (e as Error).message;
  }
  assertEquals(thrown.includes("e_mpa"), true);
});

Deno.test("parseDat - reads the spike's .dat format, computes von Mises", () => {
  const dat = [
    " displacements (vx,vy,vz) for set NALL and time  0.1000000E+01",
    "",
    "        26  1.0E-02  2.0E-02  -3.0E-02",
    "        27  1.0E-03  1.0E-03  -1.0E-03",
    "",
    " stresses (elem, integ.pnt.,sxx,syy,szz,sxy,sxz,syz) for set PART and time  0.1000000E+01",
    "",
    "       741   1  1.0E+01  0.0E+00  0.0E+00  0.0E+00  0.0E+00  0.0E+00",
  ].join("\n");

  const result = parseDat(dat);
  assertAlmostEquals(result.maxDisplacement.magnitudeMm, Math.hypot(0.01, 0.02, -0.03), 1e-12);
  assertEquals(result.maxDisplacement.nodeId, 26);
  // Uniaxial 10 MPa → von Mises exactly 10 MPa.
  assertAlmostEquals(result.maxVonMises.mpa, 10, 1e-9);
});

Deno.test("parseDat - a .dat without results is a SolveError, not silence", () => {
  let thrown: unknown;
  try {
    parseDat("nothing useful here");
  } catch (e) {
    thrown = e;
  }
  assertEquals(thrown instanceof SolveError, true);
});
