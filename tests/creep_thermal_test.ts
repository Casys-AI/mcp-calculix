/**
 * Creep (*VISCO) and coupled thermal tool tests.
 *
 * Unit tests (pure text transforms — no binaries) run unconditionally.
 * Native tests (full pipeline with gmsh + ccx) are opt-in:
 *   CALCULIX_RUN_NATIVE=1 deno test --allow-all tests/creep_thermal_test.ts
 *
 * Fixture values are from real ccx 2.21 runs on bracket.step
 * (Al 6061-like, 8 mm linear tets, 394 nodes, 1059 elements):
 *
 * Creep (*VISCO): A=1e-10 MPa^(-3) s^(-1), n=3, 500 N, 100 s, 7 increments.
 *   Last increment (t=100 s): max_disp ≈ 0.01290 mm, max_vm ≈ 8.643 MPa.
 *
 * Coupled thermal (*COUPLED TEMPERATURE-DISPLACEMENT, STEADY STATE):
 *   FIXED face (20°C, clamped) → LOADED face (200°C, free).
 *   Al 6061: conductivity=167 W/(m·K), expansion=23.6e-6/K, ref=20°C.
 *   Steady state: max_temp ≈ 200°C, max_disp ≈ 0.1236 mm, max_vm ≈ 63.35 MPa.
 */

import { assertAlmostEquals, assertEquals, assertRejects } from "@std/assert";
import { coupledThermalTools } from "../src/tools/coupled_thermal.ts";
import { creepTools } from "../src/tools/creep.ts";
import {
  assertCreepReachedRequestedDuration,
  buildCoupledThermalDeck,
  buildCreepDeck,
  parseCoupledThermalDat,
  parseDatLastIncrement,
  parseDatLastIncrementObserved,
  SolveError,
} from "../src/api/ccx.ts";
import { creepSolveTextSummary } from "../src/tools/creep.ts";

const BRACKET_STEP =
  new URL("./fixtures/bracket.step", import.meta.url).pathname;
const CREEP_DAT =
  new URL("./fixtures/bracket_creep.dat", import.meta.url).pathname;
const THERMAL_DAT =
  new URL("./fixtures/bracket_thermal.dat", import.meta.url).pathname;

const RUN_NATIVE = Deno.env.get("CALCULIX_RUN_NATIVE") === "1";

function getHandler(
  tools: { name: string; handler: (a: Record<string, unknown>) => unknown }[],
  name: string,
) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.handler;
}

/** Bracket selections — matches fixture generation parameters. */
const BRACKET_SELECTIONS = [
  { name: "FIXED", box: { min: [-31, -21, -3.1], max: [31, 21, -2.4] } },
  { name: "LOADED", box: { min: [-31, -21, 49.4], max: [-24, 21, 50.1] } },
];

// ── Unit: buildCreepDeck ──────────────────────────────────────────────────────

Deno.test("buildCreepDeck - contains *VISCO CETOL, *CREEP LAW=NORTON, *BOUNDARY, *CLOAD", () => {
  const deck = buildCreepDeck({
    inpText: "*NODE\n1, 0, 0, 0\n*NSET,NSET=FIXED\n1\n*NSET,NSET=LOADED\n2",
    maxNodeId: 10,
    material: { eMpa: 70000, nu: 0.33 },
    fixed: ["FIXED"],
    loads: [{ selection: "LOADED", totalForceN: [0, 0, -500] }],
    nodesPerSet: { FIXED: 10, LOADED: 5 },
    nortonA: 1e-10,
    nortonN: 3,
    durationS: 100,
    initialTimeDtS: 10,
  });

  assertEquals(deck.includes("*VISCO"), true);
  assertEquals(deck.includes("CETOL="), true);
  assertEquals(deck.includes("*CREEP"), true);
  assertEquals(deck.includes("LAW=NORTON"), true);
  assertEquals(deck.includes("*BOUNDARY"), true);
  assertEquals(deck.includes("FIXED,1,3"), true);
  assertEquals(deck.includes("*CLOAD"), true);
});

Deno.test("buildCreepDeck - increment line: initial_dt, duration, min_dt, max_dt", () => {
  const deck = buildCreepDeck({
    inpText: "*NSET,NSET=BASE\n1\n*NSET,NSET=TOP\n2",
    maxNodeId: 1,
    material: { eMpa: 70000, nu: 0.33 },
    fixed: ["BASE"],
    loads: [{ selection: "TOP", totalForceN: [0, 0, -100] }],
    nodesPerSet: { BASE: 4, TOP: 2 },
    nortonA: 1e-12,
    nortonN: 5,
    durationS: 3600,
    initialTimeDtS: 360,
  });

  // *VISCO card line must be followed by increment spec.
  const lines = deck.split("\n");
  const viscoIdx = lines.findIndex((l) => l.startsWith("*VISCO"));
  assertEquals(viscoIdx >= 0, true, "no *VISCO line");
  const incrementLine = lines[viscoIdx + 1];
  // Format: initial_dt, duration, min_dt, max_dt (all positive).
  const parts = incrementLine.split(",").map((s) => Number(s.trim()));
  assertEquals(parts.length, 4, "increment line must have 4 fields");
  assertEquals(parts[0], 360, "initial_dt");
  assertEquals(parts[1], 3600, "total duration");
  assertEquals(parts[2] > 0, true, "min_dt > 0");
  assertEquals(parts[3] > 0, true, "max_dt > 0");
});

Deno.test("buildCreepDeck - Norton A, n, 0 line correct", () => {
  const deck = buildCreepDeck({
    inpText: "*NSET,NSET=BASE\n1\n*NSET,NSET=TOP\n2",
    maxNodeId: 1,
    material: { eMpa: 70000, nu: 0.33 },
    fixed: ["BASE"],
    loads: [{ selection: "TOP", totalForceN: [0, 0, -100] }],
    nodesPerSet: { BASE: 4, TOP: 2 },
    nortonA: 1e-10,
    nortonN: 3,
    durationS: 100,
    initialTimeDtS: 10,
  });

  const lines = deck.split("\n");
  const creepIdx = lines.findIndex((l) => l.startsWith("*CREEP"));
  assertEquals(creepIdx >= 0, true, "no *CREEP line");
  const nortonLine = lines[creepIdx + 1];
  // A, n, 0 — third field is temperature exponent (0 = no temp dependence).
  assertEquals(nortonLine.includes("1e-10"), true);
  assertEquals(nortonLine.includes("3"), true);
  assertEquals(nortonLine.endsWith("0"), true);
});

Deno.test("buildCreepDeck - rejects norton_a ≤ 0", () => {
  let thrown = "";
  try {
    buildCreepDeck({
      inpText: "",
      maxNodeId: 1,
      material: { eMpa: 70000, nu: 0.33 },
      fixed: [],
      loads: [],
      nodesPerSet: {},
      nortonA: 0,
      nortonN: 3,
      durationS: 100,
      initialTimeDtS: 10,
    });
  } catch (e) {
    thrown = (e as Error).message;
  }
  assertEquals(thrown.includes("norton_a"), true);
});

Deno.test("buildCreepDeck - rejects initial_dt > duration_s", () => {
  let thrown = "";
  try {
    buildCreepDeck({
      inpText: "",
      maxNodeId: 1,
      material: { eMpa: 70000, nu: 0.33 },
      fixed: [],
      loads: [],
      nodesPerSet: {},
      nortonA: 1e-10,
      nortonN: 3,
      durationS: 100,
      initialTimeDtS: 200, // > duration
    });
  } catch (e) {
    thrown = (e as Error).message;
  }
  assertEquals(thrown.includes("initial_time_increment_s"), true);
  assertEquals(thrown.includes("duration"), true);
});

Deno.test("buildCreepDeck - rejects bad material", () => {
  let thrown = "";
  try {
    buildCreepDeck({
      inpText: "",
      maxNodeId: 1,
      material: { eMpa: 0, nu: 0.33 },
      fixed: [],
      loads: [],
      nodesPerSet: {},
      nortonA: 1e-10,
      nortonN: 3,
      durationS: 100,
      initialTimeDtS: 10,
    });
  } catch (e) {
    thrown = (e as Error).message;
  }
  assertEquals(thrown.includes("e_mpa"), true);
});

// ── Unit: parseDatLastIncrement ───────────────────────────────────────────────

Deno.test("parseDatLastIncrement - reads bracket_creep.dat, returns last-increment state", async () => {
  const datText = await Deno.readTextFile(CREEP_DAT);
  const result = parseDatLastIncrement(datText);

  // From real ccx 2.21 run (7 increments, last at t=100s):
  //   max_disp ≈ 0.01290 mm at node 3
  //   max_vm ≈ 8.643 MPa at element 1116
  assertAlmostEquals(result.maxDisplacement.magnitudeMm, 0.01290, 0.0005);
  assertAlmostEquals(result.maxVonMises.mpa, 8.643, 0.05);
  // Final state — displacement slightly larger than elastic-only (creep adds).
  assertEquals(result.maxDisplacement.magnitudeMm > 0, true);
  assertEquals(result.maxVonMises.mpa > 0, true);
});

Deno.test("parseDatLastIncrement - empty .dat is a SolveError", () => {
  let thrown: unknown;
  try {
    parseDatLastIncrement("nothing here");
  } catch (e) {
    thrown = e;
  }
  assertEquals(thrown instanceof SolveError, true);
});

Deno.test("parseDatLastIncrement - .dat with INCREMENT block but no data is a SolveError", () => {
  const fakedat = `
                                INCREMENT     1

 displacements (vx,vy,vz) for set NALL and time  0.1000000E+02
`;
  let thrown: unknown;
  try {
    parseDatLastIncrement(fakedat);
  } catch (e) {
    thrown = e;
  }
  assertEquals(thrown instanceof SolveError, true);
});

function creepIncrementDat(
  increment: number,
  timeToken: string,
  options: { displacementTime?: string; stressTime?: string } = {},
): string {
  const displacementTime = options.displacementTime ?? timeToken;
  const stressTime = options.stressTime ?? timeToken;
  const displacementHeader = displacementTime
    ? ` displacements (vx,vy,vz) for set NALL and time  ${displacementTime}`
    : " displacements (vx,vy,vz) for set NALL";
  const stressHeader = stressTime
    ? ` stresses (elem, integ.pnt.,sxx,syy,szz,sxy,sxz,syz) for set PART and time  ${stressTime}`
    : " stresses (elem, integ.pnt.,sxx,syy,szz,sxy,sxz,syz) for set PART";
  return `
                                INCREMENT     ${increment}

${displacementHeader}

         1  1.000000E-02  0.000000E+00  0.000000E+00

${stressHeader}

         1  1  1.000000E+01  0.000000E+00  0.000000E+00  0.000000E+00  0.000000E+00  0.000000E+00
`;
}

Deno.test("parseDatLastIncrementObserved - real fixture reports t=100 s", async () => {
  const datText = await Deno.readTextFile(CREEP_DAT);
  const last = parseDatLastIncrement(datText);
  const observed = parseDatLastIncrementObserved(datText);
  assertEquals(observed.observedTimeS, 100);
  assertAlmostEquals(
    observed.maxDisplacement.magnitudeMm,
    last.maxDisplacement.magnitudeMm,
    1e-12,
  );
  assertAlmostEquals(observed.maxVonMises.mpa, last.maxVonMises.mpa, 1e-12);
  assertCreepReachedRequestedDuration(observed.observedTimeS, 100);
});

Deno.test("parseDatLastIncrementObserved - rejects a premature final increment", () => {
  const early = creepIncrementDat(1, "0.5000000E+02");
  const observed = parseDatLastIncrementObserved(early);
  assertEquals(observed.observedTimeS, 50);
  let thrown: unknown;
  try {
    assertCreepReachedRequestedDuration(observed.observedTimeS, 100);
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof SolveError, true);
  assertEquals((thrown as Error).message.includes("observed t=50"), true);
  assertEquals((thrown as Error).message.includes("duration_s=100"), true);
});

Deno.test("parseDatLastIncrementObserved - rejects missing or disagreeing times", () => {
  assertEquals(
    parseDatLastIncrement(creepIncrementDat(1, "", {
      displacementTime: "",
      stressTime: "",
    })).maxDisplacement.nodeId,
    1,
  );
  let missing: unknown;
  try {
    parseDatLastIncrementObserved(creepIncrementDat(1, "", {
      displacementTime: "",
      stressTime: "",
    }));
  } catch (error) {
    missing = error;
  }
  assertEquals(missing instanceof SolveError, true);

  let inconsistent: unknown;
  try {
    parseDatLastIncrementObserved(creepIncrementDat(1, "0.1000000E+03", {
      displacementTime: "0.1000000E+03",
      stressTime: "0.5000000E+02",
    }));
  } catch (error) {
    inconsistent = error;
  }
  assertEquals(inconsistent instanceof SolveError, true);
  assertEquals((inconsistent as Error).message.includes("does not"), true);
});

Deno.test("creepSolveTextSummary reports observed time rather than the request", () => {
  const text = creepSolveTextSummary({
    stepSha256: "abc",
    nodeCount: 10,
    observedTimeS: 100,
    maxDisplacementMm: 0.0129,
    maxVonMisesMpa: 8.643,
  });
  assertEquals(text.includes("at observed t=100 s"), true);
  assertEquals(text.includes("after 100 s creep"), false);
});

// ── Unit: buildCoupledThermalDeck ─────────────────────────────────────────────

Deno.test("buildCoupledThermalDeck - contains all required ccx keywords", () => {
  const deck = buildCoupledThermalDeck({
    inpText: "*NODE\n1, 0, 0, 0",
    maxNodeId: 10,
    material: { eMpa: 70000, nu: 0.33 },
    conductivityWmK: 167,
    expansionPerK: 23.6e-6,
    referenceTemperatureC: 20,
    fixed: ["FIXED"],
    thermalBCs: [
      { selection: "FIXED", temperatureC: 20 },
      { selection: "LOADED", temperatureC: 200 },
    ],
    loads: [],
    nodesPerSet: { FIXED: 10, LOADED: 5 },
  });

  assertEquals(deck.includes("*COUPLED TEMPERATURE-DISPLACEMENT"), true);
  assertEquals(deck.includes("STEADY STATE"), true);
  assertEquals(deck.includes("*INITIAL CONDITIONS"), true);
  assertEquals(deck.includes("TYPE=TEMPERATURE"), true);
  assertEquals(deck.includes("*CONDUCTIVITY"), true);
  assertEquals(deck.includes("*EXPANSION"), true);
  assertEquals(deck.includes("TYPE=ISO"), true);
  // Thermal BC: DOF 11.
  assertEquals(deck.includes("FIXED,11,11,20"), true);
  assertEquals(deck.includes("LOADED,11,11,200"), true);
  // Temperature output keyword.
  assertEquals(deck.includes("NT"), true);
});

Deno.test("buildCoupledThermalDeck - conductivity written as-is (1 W/(m·K) = 1 mW/(mm·K))", () => {
  const deck = buildCoupledThermalDeck({
    inpText: "",
    maxNodeId: 1,
    material: { eMpa: 70000, nu: 0.33 },
    conductivityWmK: 167,
    expansionPerK: 23.6e-6,
    referenceTemperatureC: 20,
    fixed: ["COLD"],
    thermalBCs: [{ selection: "COLD", temperatureC: 20 }],
    loads: [],
    nodesPerSet: { COLD: 4 },
  });

  const lines = deck.split("\n");
  const condIdx = lines.findIndex((l) => l === "*CONDUCTIVITY");
  assertEquals(condIdx >= 0, true, "no *CONDUCTIVITY keyword");
  // Value on next line: 167 (no conversion factor — identity).
  assertEquals(Number(lines[condIdx + 1].trim()), 167);
});

Deno.test("buildCoupledThermalDeck - *SPECIFIC HEAT is absent (steady state)", () => {
  const deck = buildCoupledThermalDeck({
    inpText: "",
    maxNodeId: 1,
    material: { eMpa: 70000, nu: 0.33 },
    conductivityWmK: 50,
    expansionPerK: 12e-6,
    referenceTemperatureC: 20,
    fixed: ["BASE"],
    thermalBCs: [{ selection: "BASE", temperatureC: 100 }],
    loads: [],
    nodesPerSet: { BASE: 4 },
  });
  assertEquals(deck.includes("SPECIFIC HEAT"), false);
});

Deno.test("buildCoupledThermalDeck - rejects empty thermal_bcs", () => {
  let thrown = "";
  try {
    buildCoupledThermalDeck({
      inpText: "",
      maxNodeId: 1,
      material: { eMpa: 70000, nu: 0.33 },
      conductivityWmK: 50,
      expansionPerK: 12e-6,
      referenceTemperatureC: 20,
      fixed: [],
      thermalBCs: [], // must have at least one
      loads: [],
      nodesPerSet: {},
    });
  } catch (e) {
    thrown = (e as Error).message;
  }
  assertEquals(thrown.includes("thermal_bcs"), true);
  assertEquals(thrown.includes("degenerate"), true);
});

Deno.test("buildCoupledThermalDeck - rejects duplicate thermal_bcs selection", () => {
  let thrown = "";
  try {
    buildCoupledThermalDeck({
      inpText: "",
      maxNodeId: 1,
      material: { eMpa: 70000, nu: 0.33 },
      conductivityWmK: 50,
      expansionPerK: 12e-6,
      referenceTemperatureC: 20,
      fixed: [],
      thermalBCs: [
        { selection: "FACE", temperatureC: 20 },
        { selection: "FACE", temperatureC: 100 }, // duplicate
      ],
      loads: [],
      nodesPerSet: { FACE: 4 },
    });
  } catch (e) {
    thrown = (e as Error).message;
  }
  assertEquals(thrown.includes("duplicate"), true);
  assertEquals(thrown.includes("FACE"), true);
});

Deno.test("buildCoupledThermalDeck - rejects conductivity ≤ 0", () => {
  let thrown = "";
  try {
    buildCoupledThermalDeck({
      inpText: "",
      maxNodeId: 1,
      material: { eMpa: 70000, nu: 0.33 },
      conductivityWmK: 0, // invalid
      expansionPerK: 12e-6,
      referenceTemperatureC: 20,
      fixed: [],
      thermalBCs: [{ selection: "FACE", temperatureC: 100 }],
      loads: [],
      nodesPerSet: { FACE: 4 },
    });
  } catch (e) {
    thrown = (e as Error).message;
  }
  assertEquals(thrown.includes("conductivity_w_mk"), true);
});

// ── Unit: parseCoupledThermalDat ──────────────────────────────────────────────

Deno.test("parseCoupledThermalDat - reads bracket_thermal.dat, returns correct extrema", async () => {
  const datText = await Deno.readTextFile(THERMAL_DAT);
  const result = parseCoupledThermalDat(datText);

  // Real ccx 2.21 run: FIXED=20°C, LOADED=200°C, Al 6061.
  //   max_temp ≈ 200°C (hot BC nodes)
  //   max_disp ≈ 0.1236 mm (thermal expansion)
  //   max_vm ≈ 63.35 MPa (thermal stress at constraint)
  assertAlmostEquals(result.maxTemperatureC, 200, 1);
  assertAlmostEquals(result.maxDisplacement.magnitudeMm, 0.1236, 0.005);
  assertAlmostEquals(result.maxVonMises.mpa, 63.35, 1);

  assertEquals(result.maxTemperatureC > 0, true);
  assertEquals(result.maxDisplacement.magnitudeMm > 0, true);
  assertEquals(result.maxVonMises.mpa > 0, true);
});

Deno.test("parseCoupledThermalDat - empty .dat is a SolveError", () => {
  let thrown: unknown;
  try {
    parseCoupledThermalDat("nothing here");
  } catch (e) {
    thrown = e;
  }
  assertEquals(thrown instanceof SolveError, true);
});

Deno.test("parseCoupledThermalDat - .dat missing temperature section is a SolveError", () => {
  // Static .dat has displacements and stresses but no temperatures.
  const fakedat = `
 displacements (vx,vy,vz) for set NALL and time  1.000000E+00
         1  1.000000E-02 -2.000000E-03  0.000000E+00
 stresses (elem, integ.pnt.,sxx,syy,szz,sxy,sxz,syz) for set PART and time  1.000000E+00
         1  1  5.000000E+01  2.000000E+01  1.000000E+01  3.000000E+00  1.000000E+00  0.500000E+00
`;
  let thrown: unknown;
  try {
    parseCoupledThermalDat(fakedat);
  } catch (e) {
    thrown = e;
  }
  assertEquals(thrown instanceof SolveError, true);
});

// ── Tool contract ─────────────────────────────────────────────────────────────

Deno.test("calculix_solve_creep declares a closed creep-solve contract", () => {
  const tool = creepTools.find((t) => t.name === "calculix_solve_creep");
  assertEquals(tool?.outputSchema.additionalProperties, false);
  assertEquals(
    (tool?.outputSchema.required as string[]).includes("metricsAtEnd"),
    true,
  );
  // All physical creep inputs must be required.
  const required = tool?.inputSchema.required as string[];
  for (
    const field of [
      "norton_a",
      "norton_n",
      "duration_s",
      "initial_time_increment_s",
    ]
  ) {
    assertEquals(required.includes(field), true, `${field} not in required`);
  }
});

Deno.test("calculix_solve_coupled_thermal declares a closed coupled-thermal-solve contract", () => {
  const tool = coupledThermalTools.find(
    (t) => t.name === "calculix_solve_coupled_thermal",
  );
  assertEquals(tool?.outputSchema.additionalProperties, false);
  assertEquals(
    (tool?.outputSchema.required as string[]).includes("metrics"),
    true,
  );
  // Thermal inputs must be required.
  const required = tool?.inputSchema.required as string[];
  for (
    const field of [
      "conductivity_w_mk",
      "expansion_per_k",
      "reference_temperature_c",
      "thermal_bcs",
    ]
  ) {
    assertEquals(required.includes(field), true, `${field} not in required`);
  }
});

Deno.test("calculix_solve_creep - referencing an undeclared selection fails before any subprocess", async () => {
  await assertRejects(
    async () =>
      await getHandler(creepTools, "calculix_solve_creep")({
        step_path: BRACKET_STEP,
        mesh_size_mm: 8,
        material: { e_mpa: 70000, nu: 0.33 },
        norton_a: 1e-10,
        norton_n: 3,
        duration_s: 100,
        initial_time_increment_s: 10,
        selections: BRACKET_SELECTIONS,
        fixed: ["NOT_DECLARED"],
        loads: [{ selection: "LOADED", force_n: [0, 0, -500] }],
      }),
    Error,
    "NOT_DECLARED",
  );
});

Deno.test("calculix_solve_creep - a selection both fixed and loaded is rejected", async () => {
  await assertRejects(
    async () =>
      await getHandler(creepTools, "calculix_solve_creep")({
        step_path: BRACKET_STEP,
        mesh_size_mm: 8,
        material: { e_mpa: 70000, nu: 0.33 },
        norton_a: 1e-10,
        norton_n: 3,
        duration_s: 100,
        initial_time_increment_s: 10,
        selections: BRACKET_SELECTIONS,
        fixed: ["FIXED"],
        loads: [{ selection: "FIXED", force_n: [0, 0, -500] }],
      }),
    Error,
    "both fixed and loaded",
  );
});

Deno.test("calculix_solve_coupled_thermal - referencing an undeclared selection fails before subprocess", async () => {
  await assertRejects(
    async () =>
      await getHandler(coupledThermalTools, "calculix_solve_coupled_thermal")({
        step_path: BRACKET_STEP,
        mesh_size_mm: 8,
        material: { e_mpa: 70000, nu: 0.33 },
        conductivity_w_mk: 167,
        expansion_per_k: 23.6e-6,
        reference_temperature_c: 20,
        selections: BRACKET_SELECTIONS,
        fixed: ["FIXED"],
        thermal_bcs: [
          { selection: "NOT_DECLARED", temperature_c: 200 },
        ],
      }),
    Error,
    "NOT_DECLARED",
  );
});

Deno.test("calculix_solve_coupled_thermal - duplicate thermal_bcs selection is rejected before subprocess", async () => {
  await assertRejects(
    async () =>
      await getHandler(coupledThermalTools, "calculix_solve_coupled_thermal")({
        step_path: BRACKET_STEP,
        mesh_size_mm: 8,
        material: { e_mpa: 70000, nu: 0.33 },
        conductivity_w_mk: 167,
        expansion_per_k: 23.6e-6,
        reference_temperature_c: 20,
        selections: BRACKET_SELECTIONS,
        fixed: ["FIXED"],
        thermal_bcs: [
          { selection: "FIXED", temperature_c: 20 },
          { selection: "FIXED", temperature_c: 100 }, // duplicate
        ],
      }),
    SolveError,
    "duplicate",
  );
});

// ── Native opt-in: full pipeline ──────────────────────────────────────────────

Deno.test({
  name:
    "calculix_solve_creep - bracket under 500 N creep 100s, Norton A=1e-10 n=3",
  ignore: !RUN_NATIVE,
  fn: async () => {
    const result = await getHandler(creepTools, "calculix_solve_creep")({
      step_path: BRACKET_STEP,
      mesh_size_mm: 8,
      element_order: 1,
      material: { e_mpa: 70000, nu: 0.33 },
      norton_a: 1e-10,
      norton_n: 3,
      duration_s: 100,
      initial_time_increment_s: 10,
      selections: BRACKET_SELECTIONS,
      fixed: ["FIXED"],
      loads: [{ selection: "LOADED", force_n: [0, 0, -500] }],
    }) as { structuredContent: Record<string, unknown> };

    const structured = result.structuredContent;
    assertEquals(structured.schemaVersion, "1.0");
    assertEquals(structured.kind, "creep-solve");

    const creepMeta = structured.creep as {
      nortonA: number;
      nortonN: number;
      durationS: number;
    };
    assertEquals(creepMeta.nortonA, 1e-10);
    assertEquals(creepMeta.nortonN, 3);
    assertEquals(creepMeta.durationS, 100);

    const metrics = structured.metricsAtEnd as {
      maxDisplacement: { value: number };
      maxVonMises: { value: number };
    };
    // Last-increment state at t=100s.
    assertEquals(metrics.maxDisplacement.value > 0, true);
    assertEquals(metrics.maxVonMises.value > 0, true);
    // Must be close to the fixture reference values.
    assertAlmostEquals(metrics.maxDisplacement.value, 0.01290, 0.002);
    assertAlmostEquals(metrics.maxVonMises.value, 8.643, 0.5);
  },
});

Deno.test({
  name:
    "calculix_solve_coupled_thermal - bracket FIXED=20°C, LOADED=200°C, Al 6061",
  ignore: !RUN_NATIVE,
  fn: async () => {
    const result = await getHandler(
      coupledThermalTools,
      "calculix_solve_coupled_thermal",
    )({
      step_path: BRACKET_STEP,
      mesh_size_mm: 8,
      element_order: 1,
      material: { e_mpa: 70000, nu: 0.33 },
      conductivity_w_mk: 167,
      expansion_per_k: 23.6e-6,
      reference_temperature_c: 20,
      selections: BRACKET_SELECTIONS,
      fixed: ["FIXED"],
      thermal_bcs: [
        { selection: "FIXED", temperature_c: 20 },
        { selection: "LOADED", temperature_c: 200 },
      ],
    }) as { structuredContent: Record<string, unknown> };

    const structured = result.structuredContent;
    assertEquals(structured.schemaVersion, "1.0");
    assertEquals(structured.kind, "coupled-thermal-solve");

    const metrics = structured.metrics as {
      maxTemperature: { value: number };
      maxDisplacement: { value: number };
      maxVonMises: { value: number };
    };
    // Hot BC nodes reach 200°C.
    assertAlmostEquals(metrics.maxTemperature.value, 200, 1);
    // Thermal expansion drives significant displacement.
    assertEquals(metrics.maxDisplacement.value > 0.05, true);
    assertAlmostEquals(metrics.maxDisplacement.value, 0.1236, 0.01);
    // Constrained thermal expansion → stress.
    assertEquals(metrics.maxVonMises.value > 0, true);
    assertAlmostEquals(metrics.maxVonMises.value, 63.35, 3);

    const material = structured.material as { conductivityWmK: number };
    assertEquals(material.conductivityWmK, 167);
  },
});
