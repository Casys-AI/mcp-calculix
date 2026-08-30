/**
 * Ordinary-solve preflight: invalid common physical inputs must fail before
 * snapshotStepArtifact or any native subprocess.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { Ajv2020 } from "ajv/dist/2020.js";
import { InputArtifactError } from "../src/api/input-artifact.ts";
import { buckleTools } from "../src/tools/buckling.ts";
import { coupledThermalTools } from "../src/tools/coupled_thermal.ts";
import { creepTools } from "../src/tools/creep.ts";
import { modalTools } from "../src/tools/modal.ts";
import {
  MAX_MESH_PREFLIGHT_SELECTIONS,
  MAX_ORDINARY_SOLVE_TIMEOUT_MS,
  OrdinaryInputError,
} from "../src/tools/ordinary-preflight.ts";
import { solveTools } from "../src/tools/solve.ts";
import type { CalculixTool } from "../src/tools/types.ts";

const MISSING_STEP =
  "/this/path/does/not/exist/mcp-calculix-ordinary-preflight.step";

const SELECTIONS = [
  { name: "FIXED", box: { min: [-31, -21, -3.1], max: [31, 21, -2.4] } },
  { name: "LOADED", box: { min: [-31, -21, 49.4], max: [-24, 21, 50.1] } },
];

const COMMON = {
  step_path: MISSING_STEP,
  mesh_size_mm: 4,
  material: { e_mpa: 70000, nu: 0.33 },
  selections: structuredClone(SELECTIONS),
  fixed: ["FIXED"],
};

function handler(tools: CalculixTool[], name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.handler;
}

function schemaOf(
  tools: CalculixTool[],
  name: string,
): Record<string, unknown> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.inputSchema;
}

function payload(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...structuredClone(COMMON),
    loads: [{ selection: "LOADED", force_n: [0, 0, -500] }],
    ...extra,
  };
}

const ORDINARY: Array<{
  name: string;
  tools: CalculixTool[];
  args: Record<string, unknown>;
}> = [
  {
    name: "calculix_solve_static",
    tools: solveTools,
    args: payload(),
  },
  {
    name: "calculix_solve_modal",
    tools: modalTools,
    args: { ...structuredClone(COMMON), density_kg_m3: 2700 },
  },
  {
    name: "calculix_solve_buckling",
    tools: buckleTools,
    args: payload(),
  },
  {
    name: "calculix_solve_creep",
    tools: creepTools,
    args: payload({
      norton_a: 1e-10,
      norton_n: 3,
      duration_s: 100,
      initial_time_increment_s: 10,
    }),
  },
  {
    name: "calculix_solve_coupled_thermal",
    tools: coupledThermalTools,
    args: {
      ...structuredClone(COMMON),
      conductivity_w_mk: 167,
      expansion_per_k: 23.6e-6,
      reference_temperature_c: 20,
      thermal_bcs: [
        { selection: "FIXED", temperature_c: 20 },
        { selection: "LOADED", temperature_c: 200 },
      ],
    },
  },
];

Deno.test("ordinary input schemas tighten shared physical bounds", () => {
  for (const { name, tools } of ORDINARY) {
    const properties = schemaOf(tools, name).properties as Record<
      string,
      unknown
    >;
    assertEquals(
      (properties.mesh_size_mm as { exclusiveMinimum: number })
        .exclusiveMinimum,
      0,
      name,
    );
    assertEquals(
      (properties.element_order as { type: string }).type,
      "integer",
      name,
    );
    assertEquals(
      (properties.timeout_ms as { type: string; minimum: number }).type,
      "integer",
      name,
    );
    assertEquals(
      (properties.timeout_ms as { minimum: number }).minimum,
      1,
      name,
    );
    assertEquals(
      (properties.timeout_ms as { maximum: number }).maximum,
      MAX_ORDINARY_SOLVE_TIMEOUT_MS,
      name,
    );
    const material = properties.material as {
      properties: {
        e_mpa: { exclusiveMinimum: number };
        nu: { exclusiveMinimum: number; exclusiveMaximum: number };
      };
    };
    assertEquals(material.properties.e_mpa.exclusiveMinimum, 0, name);
    assertEquals(material.properties.nu.exclusiveMinimum, 0, name);
    assertEquals(material.properties.nu.exclusiveMaximum, 0.5, name);
    const selections = properties.selections as {
      maxItems: number;
      items: { properties: { name: { pattern: string } } };
    };
    assertEquals(selections.maxItems, MAX_MESH_PREFLIGHT_SELECTIONS, name);
    assertEquals(
      selections.items.properties.name.pattern,
      "^[A-Za-z][A-Za-z0-9_]{0,60}$",
      name,
    );
  }
});

Deno.test("ordinary input schemas close every documented object", () => {
  for (const { name, tools } of ORDINARY) {
    assertObjectSchemasClosed(schemaOf(tools, name), name);
  }
});

Deno.test("ordinary handlers reject unknown documented-input fields before snapshot", async () => {
  const mutations: Array<{
    path: string;
    mutate: (value: Record<string, unknown>) => void;
  }> = [
    {
      path: "unexpected",
      mutate: (value) => value.unexpected = true,
    },
    {
      path: "material.unexpected",
      mutate: (value) => {
        (value.material as Record<string, unknown>).unexpected = true;
      },
    },
    {
      path: "selections[0].unexpected",
      mutate: (value) => {
        (value.selections as Array<Record<string, unknown>>)[0].unexpected =
          true;
      },
    },
    {
      path: "selections[0].box.unexpected",
      mutate: (value) => {
        (((value.selections as Array<Record<string, unknown>>)[0]
          .box) as Record<
            string,
            unknown
          >).unexpected = true;
      },
    },
  ];

  for (const { name, tools, args } of ORDINARY) {
    for (const { path, mutate } of mutations) {
      const invalid = structuredClone(args);
      mutate(invalid);
      const error = await assertRejects(
        async () => await handler(tools, name)(invalid),
        OrdinaryInputError,
        path,
      );
      assertEquals(error.code, "unknown_input_field", `${name} ${path}`);
      assertEquals(error.inputPath, path, `${name} ${path}`);
      assertEquals(
        error.message.includes("not found"),
        false,
        `${name} ${path}`,
      );
    }
  }
});

Deno.test("ordinary solves still snapshot a missing STEP when inputs are otherwise valid", async () => {
  for (const { name, tools, args } of ORDINARY) {
    await assertRejects(
      async () => await handler(tools, name)(structuredClone(args)),
      InputArtifactError,
      "not found",
    );
  }
});

Deno.test("invalid mesh_size_mm fails before snapshot on a missing STEP", async () => {
  for (const { name, tools, args } of ORDINARY) {
    const error = await assertRejects(
      async () =>
        await handler(tools, name)({
          ...structuredClone(args),
          mesh_size_mm: 0,
        }),
      OrdinaryInputError,
      "mesh_size_mm",
    );
    assertEquals(error.message.includes("not found"), false, name);
  }
});

Deno.test("invalid material, boxes, names, timeout, digest, and element_order fail before snapshot", async () => {
  const cases: Array<{ extra: Record<string, unknown>; needle: string }> = [
    { extra: { material: { e_mpa: 0, nu: 0.33 } }, needle: "e_mpa" },
    { extra: { material: { e_mpa: 70000, nu: 0.5 } }, needle: "nu" },
    { extra: { timeout_ms: 1.5 }, needle: "timeout_ms" },
    { extra: { timeout_ms: 0 }, needle: "timeout_ms" },
    { extra: { element_order: 3 }, needle: "element_order" },
    {
      extra: { expected_step_sha256: "not-a-digest" },
      needle: "expected_step_sha256",
    },
    {
      extra: {
        selections: [
          { name: "FIXED", box: { min: [1, 0, 0], max: [0, 1, 1] } },
        ],
        fixed: ["FIXED"],
      },
      needle: "strictly below",
    },
    {
      extra: {
        selections: [
          {
            name: "BAD NAME",
            box: { min: [0, 0, 0], max: [1, 1, 1] },
          },
        ],
        fixed: ["FIXED"],
      },
      needle: "invalid or duplicate name",
    },
    {
      extra: {
        selections: [
          { name: "FIXED", box: { min: [0, 0, 0], max: [1, 1, 1] } },
          { name: "FIXED", box: { min: [2, 0, 0], max: [3, 1, 1] } },
        ],
        fixed: ["FIXED"],
      },
      needle: "invalid or duplicate name",
    },
  ];

  for (const { name, tools, args } of ORDINARY) {
    for (const { extra, needle } of cases) {
      const error = await assertRejects(
        async () =>
          await handler(tools, name)({ ...structuredClone(args), ...extra }),
        OrdinaryInputError,
        needle,
      );
      assertEquals(
        error.message.includes("not found"),
        false,
        `${name} ${needle}`,
      );
    }
  }
});

Deno.test("ordinary solve timeout is bounded in schema and direct handlers", async () => {
  for (const { name, tools, args } of ORDINARY) {
    const validateSchema = new Ajv2020({ strict: false }).compile(
      schemaOf(tools, name),
    );
    assertEquals(
      validateSchema({
        ...structuredClone(args),
        timeout_ms: MAX_ORDINARY_SOLVE_TIMEOUT_MS,
      }),
      true,
      `${name} schema accepts the maximum`,
    );

    const atBoundary = await assertRejects(
      async () =>
        await handler(tools, name)({
          ...structuredClone(args),
          timeout_ms: MAX_ORDINARY_SOLVE_TIMEOUT_MS,
        }),
      InputArtifactError,
      "not found",
    );
    assert(atBoundary instanceof InputArtifactError, name);

    for (
      const timeoutMs of [
        MAX_ORDINARY_SOLVE_TIMEOUT_MS + 1,
        Number.MAX_SAFE_INTEGER,
      ]
    ) {
      assertEquals(
        validateSchema({ ...structuredClone(args), timeout_ms: timeoutMs }),
        false,
        `${name} schema rejects ${timeoutMs}`,
      );
      const error = await assertRejects(
        async () =>
          await handler(tools, name)({
            ...structuredClone(args),
            timeout_ms: timeoutMs,
          }),
        OrdinaryInputError,
        "timeout_ms",
      );
      assertEquals(error.code, "timeout_out_of_range", name);
      assertEquals(error.inputPath, "timeout_ms", name);
      assertEquals(error.message.includes("not found"), false, name);
    }
  }
});

Deno.test("undeclared and overlapping mechanical names still fail before snapshot", async () => {
  const staticError = await assertRejects(
    async () =>
      await handler(solveTools, "calculix_solve_static")({
        ...payload(),
        fixed: ["NOT_DECLARED"],
      }),
    OrdinaryInputError,
    "NOT_DECLARED",
  );
  assertEquals(staticError.message.includes("not found"), false);

  await assertRejects(
    async () =>
      await handler(solveTools, "calculix_solve_static")({
        ...payload(),
        loads: [{ selection: "FIXED", force_n: [0, 0, -500] }],
      }),
    OrdinaryInputError,
    "both fixed and loaded",
  );

  await assertRejects(
    async () =>
      await handler(modalTools, "calculix_solve_modal")({
        ...structuredClone(COMMON),
        density_kg_m3: 2700,
        fixed: ["NOT_DECLARED"],
      }),
    OrdinaryInputError,
    "NOT_DECLARED",
  );

  await assertRejects(
    async () =>
      await handler(coupledThermalTools, "calculix_solve_coupled_thermal")({
        ...structuredClone(COMMON),
        conductivity_w_mk: 167,
        expansion_per_k: 23.6e-6,
        reference_temperature_c: 20,
        thermal_bcs: [{ selection: "NOT_DECLARED", temperature_c: 200 }],
      }),
    OrdinaryInputError,
    "NOT_DECLARED",
  );
});

Deno.test("buckling rejects an all-zero reference preload before snapshot", async () => {
  const error = await assertRejects(
    async () =>
      await handler(buckleTools, "calculix_solve_buckling")(
        payload({
          loads: [{ selection: "LOADED", force_n: [0, 0, 0] }],
        }),
      ),
    OrdinaryInputError,
    "non-zero force_n",
  );
  assertEquals(error.code, "zero_reference_load");
  assertEquals(error.inputPath, "loads");
});

Deno.test("coupled thermal rejects an unknown thermal boundary field before snapshot", async () => {
  const error = await assertRejects(
    async () =>
      await handler(coupledThermalTools, "calculix_solve_coupled_thermal")({
        ...structuredClone(COMMON),
        conductivity_w_mk: 167,
        expansion_per_k: 23.6e-6,
        reference_temperature_c: 20,
        thermal_bcs: [{
          selection: "FIXED",
          temperature_c: 20,
          unexpected: true,
        }],
      }),
    OrdinaryInputError,
    "thermal_bcs[0].unexpected",
  );
  assertEquals(error.code, "unknown_input_field");
  assertEquals(error.inputPath, "thermal_bcs[0].unexpected");
});

Deno.test("coupled thermal still allows a thermal BC on a mechanically fixed selection", async () => {
  const error = await assertRejects(
    async () =>
      await handler(coupledThermalTools, "calculix_solve_coupled_thermal")({
        ...structuredClone(COMMON),
        conductivity_w_mk: 167,
        expansion_per_k: 23.6e-6,
        reference_temperature_c: 20,
        thermal_bcs: [{ selection: "FIXED", temperature_c: 20 }],
      }),
    InputArtifactError,
    "not found",
  );
  assert(error instanceof InputArtifactError);
});

function assertObjectSchemasClosed(value: unknown, name: string): void {
  if (!isRecord(value)) return;
  if (value.type === "object") {
    assertEquals(value.additionalProperties, false, name);
  }
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) assertObjectSchemasClosed(item, name);
    } else {
      assertObjectSchemasClosed(child, name);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
