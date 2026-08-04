/**
 * Modal and buckling tool tests.
 *
 * Unit tests (pure text transforms — no binaries) run unconditionally.
 * Native tests (full pipeline with gmsh + ccx) are opt-in:
 *   CALCULIX_RUN_NATIVE=1 deno test --allow-all tests/modal_buckle_test.ts
 */

import { assertAlmostEquals, assertEquals, assertRejects } from "@std/assert";
import { buckleTools } from "../src/tools/buckling.ts";
import { modalTools } from "../src/tools/modal.ts";
import {
  buildBuckleDeck,
  buildModalDeck,
  parseBuckleDat,
  parseModalDat,
  SolveError,
} from "../src/api/ccx.ts";

const BRACKET_STEP =
  new URL("./fixtures/bracket.step", import.meta.url).pathname;
const MODAL_DAT =
  new URL("./fixtures/bracket_modal.dat", import.meta.url).pathname;
const BUCKLE_DAT =
  new URL("./fixtures/bracket_buckle.dat", import.meta.url).pathname;

const RUN_NATIVE = Deno.env.get("CALCULIX_RUN_NATIVE") === "1";

function getHandler(
  tools: { name: string; handler: (a: Record<string, unknown>) => unknown }[],
  name: string,
) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.handler;
}

/** Bracket + Al 6061 + fixed base, 500 N down — matches the static test case. */
const BRACKET_SELECTIONS = [
  { name: "FIXED", box: { min: [-31, -21, -3.1], max: [31, 21, -2.4] } },
  { name: "LOADED", box: { min: [-31, -21, 49.4], max: [-24, 21, 50.1] } },
];

// ── Unit: buildModalDeck ──────────────────────────────────────────────────────

Deno.test("buildModalDeck - includes DENSITY with uppercase-E notation", () => {
  const deck = buildModalDeck({
    inpText: "*NODE\n1, 0, 0, 0",
    maxNodeId: 10,
    material: { eMpa: 70000, nu: 0.33 },
    densityKgM3: 2700,
    fixed: ["FIXED"],
    nModes: 3,
  });

  assertEquals(deck.includes("*DENSITY"), true);
  // CalculiX rejects lowercase-e; the density must use uppercase E.
  // 2700 kg/m³ × 1e-12 = 2.700000E-9 t/mm³.
  const densityLine = deck.split("\n").find((l) => l.match(/E[-+]\d+/i));
  assertEquals(densityLine !== undefined, true);
  assertEquals(/E[-+]/i.test(densityLine!), true);
  // Confirm the value is uppercase (not lowercase) in the actual deck line.
  assertEquals(/e[-+]/g.test(densityLine!), false // no lowercase e
  );
});

Deno.test("buildModalDeck - density conversion: 2700 kg/m³ → 2.700000E-9 t/mm³", () => {
  const deck = buildModalDeck({
    inpText: "",
    maxNodeId: 1,
    material: { eMpa: 70000, nu: 0.33 },
    densityKgM3: 2700,
    fixed: ["BASE"],
    nModes: 1,
  });

  // Find the line immediately after *DENSITY.
  const lines = deck.split("\n");
  const idx = lines.findIndex((l) => l === "*DENSITY");
  assertEquals(idx >= 0, true, "no *DENSITY keyword found");
  const densityStr = lines[idx + 1];
  // The value must be 2700 * 1e-12 = 2.7e-9 rendered with uppercase E.
  const val = Number(densityStr);
  assertAlmostEquals(val, 2700 * 1e-12, 1e-22);
  assertEquals(
    /E/i.test(densityStr),
    true,
    "density not in scientific notation",
  );
  assertEquals(
    densityStr.includes("e"),
    false,
    "density uses lowercase e — ccx will reject it",
  );
});

Deno.test("buildModalDeck - includes *FREQUENCY, n_modes, *BOUNDARY, no *CLOAD", () => {
  const deck = buildModalDeck({
    inpText: "*NODE\n1, 0, 0, 0",
    maxNodeId: 5,
    material: { eMpa: 210000, nu: 0.30 },
    densityKgM3: 7850,
    fixed: ["BASE"],
    nModes: 4,
  });

  assertEquals(deck.includes("*FREQUENCY"), true);
  assertEquals(deck.includes("\n4\n"), true); // n_modes line
  assertEquals(deck.includes("BASE,1,3"), true);
  // Modal analysis has no loads — *CLOAD must not appear.
  assertEquals(deck.includes("*CLOAD"), false);
});

Deno.test("buildModalDeck - rejects missing density (density_kg_m3 = 0)", () => {
  let thrown = "";
  try {
    buildModalDeck({
      inpText: "",
      maxNodeId: 1,
      material: { eMpa: 70000, nu: 0.33 },
      densityKgM3: 0,
      fixed: [],
      nModes: 1,
    });
  } catch (e) {
    thrown = (e as Error).message;
  }
  assertEquals(thrown.includes("density_kg_m3"), true);
  assertEquals(thrown.includes("no default"), true);
});

Deno.test("buildModalDeck - rejects bad material (e_mpa ≤ 0)", () => {
  let thrown = "";
  try {
    buildModalDeck({
      inpText: "",
      maxNodeId: 1,
      material: { eMpa: -1, nu: 0.33 },
      densityKgM3: 2700,
      fixed: [],
      nModes: 1,
    });
  } catch (e) {
    thrown = (e as Error).message;
  }
  assertEquals(thrown.includes("e_mpa"), true);
});

Deno.test("buildModalDeck - rejects n_modes outside [1, 30]", () => {
  let thrown = "";
  try {
    buildModalDeck({
      inpText: "",
      maxNodeId: 1,
      material: { eMpa: 70000, nu: 0.33 },
      densityKgM3: 2700,
      fixed: [],
      nModes: 31,
    });
  } catch (e) {
    thrown = (e as Error).message;
  }
  assertEquals(thrown.includes("n_modes"), true);
  assertEquals(thrown.includes("30"), true);
});

// ── Unit: parseModalDat ───────────────────────────────────────────────────────

Deno.test("parseModalDat - reads bracket_modal.dat, f_hz = omega/(2π) within tolerance", async () => {
  const datText = await Deno.readTextFile(MODAL_DAT);
  const result = parseModalDat(datText);

  assertEquals(result.frequenciesHz.length, 3);

  // From the real ccx run on bracket.step (Al 6061, 4mm mesh, fixed base):
  //   mode 1: omega = 0.1107672E+05 rad/s, f = 0.1762914E+04 Hz
  //   mode 2: omega = 0.2973545E+05 rad/s, f = 0.4732544E+04 Hz
  //   mode 3: omega = 0.5840918E+05 rad/s, f = 0.9296110E+04 Hz
  assertAlmostEquals(result.frequenciesHz[0], 1762.914, 0.5);
  assertAlmostEquals(result.frequenciesHz[1], 4732.544, 1);
  assertAlmostEquals(result.frequenciesHz[2], 9296.11, 1);

  // Risk guard: f_hz must equal omega_rad_s / (2π).
  // The first mode omega is 11076.72 rad/s → f = 11076.72 / 2π ≈ 1762.9 Hz.
  const omega1 = 1.107672e4; // rad/s from the .dat
  assertAlmostEquals(
    result.frequenciesHz[0],
    omega1 / (2 * Math.PI),
    0.5,
    "f_hz is not omega/(2π) — parser may be reading the wrong column",
  );
});

Deno.test("parseModalDat - empty .dat is a SolveError, not silence", () => {
  let thrown: unknown;
  try {
    parseModalDat("nothing useful here");
  } catch (e) {
    thrown = e;
  }
  assertEquals(thrown instanceof SolveError, true);
});

// ── Unit: buildBuckleDeck ─────────────────────────────────────────────────────

Deno.test("buildBuckleDeck - two-step deck: *STATIC then *BUCKLE", () => {
  const deck = buildBuckleDeck({
    inpText: "*NODE\n1, 0, 0, 0",
    maxNodeId: 100,
    material: { eMpa: 70000, nu: 0.33 },
    fixed: ["FIXED"],
    loads: [{ selection: "LOADED", totalForceN: [0, 0, -500] }],
    nodesPerSet: { FIXED: 10, LOADED: 50 },
    nModes: 2,
  });

  // Both steps must be present and in the right order.
  const staticIdx = deck.indexOf("*STATIC");
  const buckleIdx = deck.indexOf("*BUCKLE");
  assertEquals(staticIdx >= 0, true, "no *STATIC step");
  assertEquals(buckleIdx > staticIdx, true, "*BUCKLE must come after *STATIC");

  // n_modes line immediately after *BUCKLE.
  const lines = deck.split("\n");
  const buckleLineIdx = lines.findIndex((l) => l === "*BUCKLE");
  assertEquals(lines[buckleLineIdx + 1], "2");

  // Loads must appear in both steps.
  const firstStep = deck.slice(0, buckleIdx);
  const secondStep = deck.slice(buckleIdx);
  assertEquals(firstStep.includes("*CLOAD"), true, "no *CLOAD in step 1");
  assertEquals(secondStep.includes("*CLOAD"), true, "no *CLOAD in step 2");

  // Per-node force: 500/50 = 10 N/node on axis 3.
  assertEquals(deck.includes("LOADED,3,-10"), true);
});

Deno.test("buildBuckleDeck - rejects n_modes outside [1, 30]", () => {
  let thrown = "";
  try {
    buildBuckleDeck({
      inpText: "",
      maxNodeId: 1,
      material: { eMpa: 70000, nu: 0.33 },
      fixed: [],
      loads: [],
      nodesPerSet: {},
      nModes: 0,
    });
  } catch (e) {
    thrown = (e as Error).message;
  }
  assertEquals(thrown.includes("n_modes"), true);
});

Deno.test("buildBuckleDeck - rejects bad material", () => {
  let thrown = "";
  try {
    buildBuckleDeck({
      inpText: "",
      maxNodeId: 1,
      material: { eMpa: 0, nu: 0.33 },
      fixed: [],
      loads: [],
      nodesPerSet: {},
      nModes: 1,
    });
  } catch (e) {
    thrown = (e as Error).message;
  }
  assertEquals(thrown.includes("e_mpa"), true);
});

// ── Unit: parseBuckleDat ──────────────────────────────────────────────────────

Deno.test("parseBuckleDat - reads bracket_buckle.dat, returns correct load factors", async () => {
  const datText = await Deno.readTextFile(BUCKLE_DAT);
  const result = parseBuckleDat(datText);

  assertEquals(result.loadFactors.length, 2);

  // From the real ccx run on bracket.step (Al 6061, 4mm mesh, 500 N):
  //   mode 1 factor = 0.6110847E+02 → 61.1
  //   mode 2 factor = 0.5144368E+03 → 514.4
  // Critical load = factor × 500 N:
  //   mode 1: 61.1 × 500 = 30,550 N ≈ 30.6 kN
  assertAlmostEquals(result.loadFactors[0], 61.11, 0.1);
  assertAlmostEquals(result.loadFactors[1], 514.4, 0.5);
});

Deno.test("parseBuckleDat - empty .dat is a SolveError, not silence", () => {
  let thrown: unknown;
  try {
    parseBuckleDat("nothing useful here");
  } catch (e) {
    thrown = e;
  }
  assertEquals(thrown instanceof SolveError, true);
});

// ── Tool contract ─────────────────────────────────────────────────────────────

Deno.test("calculix_solve_modal declares a closed modal-solve contract", () => {
  const tool = modalTools.find((t) => t.name === "calculix_solve_modal");
  assertEquals(tool?.outputSchema.additionalProperties, false);
  assertEquals(
    (tool?.outputSchema.required as string[]).includes("metrics"),
    true,
  );
  // density_kg_m3 must be in required inputs.
  const required = tool?.inputSchema.required as string[];
  assertEquals(required.includes("density_kg_m3"), true);
});

Deno.test("calculix_solve_buckling declares a closed buckle-solve contract", () => {
  const tool = buckleTools.find((t) => t.name === "calculix_solve_buckling");
  assertEquals(tool?.outputSchema.additionalProperties, false);
  assertEquals(
    (tool?.outputSchema.required as string[]).includes("metrics"),
    true,
  );
  // loads must be required (no reference preload → no meaningful buckle).
  const required = tool?.inputSchema.required as string[];
  assertEquals(required.includes("loads"), true);
});

Deno.test("calculix_solve_modal - referencing an undeclared selection fails before any subprocess", async () => {
  await assertRejects(
    async () =>
      await getHandler(modalTools, "calculix_solve_modal")({
        step_path: BRACKET_STEP,
        mesh_size_mm: 4,
        material: { e_mpa: 70000, nu: 0.33 },
        density_kg_m3: 2700,
        selections: BRACKET_SELECTIONS,
        fixed: ["NOT_DECLARED"],
      }),
    Error,
    "NOT_DECLARED",
  );
});

Deno.test("calculix_solve_buckling - referencing an undeclared selection fails before any subprocess", async () => {
  await assertRejects(
    async () =>
      await getHandler(buckleTools, "calculix_solve_buckling")({
        step_path: BRACKET_STEP,
        mesh_size_mm: 4,
        material: { e_mpa: 70000, nu: 0.33 },
        selections: BRACKET_SELECTIONS,
        fixed: ["NOT_DECLARED"],
        loads: [{ selection: "LOADED", force_n: [0, 0, -500] }],
      }),
    Error,
    "NOT_DECLARED",
  );
});

Deno.test("calculix_solve_buckling - a selection both fixed and loaded is rejected", async () => {
  await assertRejects(
    async () =>
      await getHandler(buckleTools, "calculix_solve_buckling")({
        step_path: BRACKET_STEP,
        mesh_size_mm: 4,
        material: { e_mpa: 70000, nu: 0.33 },
        selections: BRACKET_SELECTIONS,
        fixed: ["FIXED"],
        loads: [{ selection: "FIXED", force_n: [0, 0, -500] }],
      }),
    Error,
    "both fixed and loaded",
  );
});

// ── Native opt-in: full pipeline ──────────────────────────────────────────────

Deno.test({
  name:
    "calculix_solve_modal - bracket natural frequencies, Al 6061, fixed base",
  ignore: !RUN_NATIVE,
  fn: async () => {
    const result = await getHandler(modalTools, "calculix_solve_modal")({
      step_path: BRACKET_STEP,
      mesh_size_mm: 4,
      material: { e_mpa: 70000, nu: 0.33 },
      density_kg_m3: 2700,
      selections: BRACKET_SELECTIONS,
      fixed: ["FIXED"],
      n_modes: 3,
    }) as { structuredContent: Record<string, unknown> };

    const structured = result.structuredContent;
    assertEquals(structured.schemaVersion, "1.0");
    assertEquals(structured.kind, "modal-solve");

    const metrics = structured.metrics as { frequenciesHz: number[] };
    assertEquals(metrics.frequenciesHz.length, 3);
    // Real values from the real ccx run: f1 ≈ 1762.9 Hz
    assertEquals(metrics.frequenciesHz[0] > 1000, true);
    assertEquals(metrics.frequenciesHz[0] < 5000, true);
    // Ascending order guaranteed by ccx.
    assertEquals(metrics.frequenciesHz[1] > metrics.frequenciesHz[0], true);
    assertEquals(metrics.frequenciesHz[2] > metrics.frequenciesHz[1], true);

    const material = structured.material as { densityKgM3: number };
    assertEquals(material.densityKgM3, 2700);
  },
});

Deno.test({
  name: "calculix_solve_buckling - bracket under 500 N: critical load factors",
  ignore: !RUN_NATIVE,
  fn: async () => {
    const result = await getHandler(buckleTools, "calculix_solve_buckling")({
      step_path: BRACKET_STEP,
      mesh_size_mm: 4,
      material: { e_mpa: 70000, nu: 0.33 },
      selections: BRACKET_SELECTIONS,
      fixed: ["FIXED"],
      loads: [{ selection: "LOADED", force_n: [0, 0, -500] }],
      n_modes: 2,
    }) as { structuredContent: Record<string, unknown> };

    const structured = result.structuredContent;
    assertEquals(structured.schemaVersion, "1.0");
    assertEquals(structured.kind, "buckle-solve");

    const metrics = structured.metrics as { loadFactors: number[] };
    assertEquals(metrics.loadFactors.length, 2);
    // From the real ccx run: mode 1 factor ≈ 61.1 (P_crit ≈ 30.6 kN)
    assertEquals(metrics.loadFactors[0] > 1, true); // bracket not yet at critical load
    assertAlmostEquals(metrics.loadFactors[0], 61.11, 5);
    assertEquals(metrics.loadFactors[1] > metrics.loadFactors[0], true);
  },
});
