/** Mesh-only preflight coverage without Gmsh or CalculiX installed. */

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  inspectInp,
  inspectMeshNodeBounds,
  MeshingError,
  type MeshPreflightResult as GmshMeshPreflightResult,
  meshStepPreflight,
  meshStepRecorded,
} from "../src/api/gmsh.ts";
import { OrdinaryInputError } from "../src/tools/ordinary-preflight.ts";
import {
  createMeshPreflightTools,
  MESH_PREFLIGHT_INPUT_SCHEMA,
  MESH_PREFLIGHT_TOOL_NAME,
} from "../src/tools/mesh-preflight.ts";

const INPUT = {
  mesh_size_mm: 2,
  selections: [
    { name: "FIXED", box: { min: [0, 0, 0], max: [1, 2, 3] } },
    { name: "EMPTY", box: { min: [8, 8, 8], max: [9, 9, 9] } },
  ],
};

const FAKE_PREFLIGHT: GmshMeshPreflightResult = {
  mesh: {
    inpText: "*NODE\n1, 0, 0, 0\n",
    nodeCount: 4,
    elementCount: 1,
    maxNodeId: 4,
    nodesPerSet: { FIXED: 3 },
  },
  bounds: { min: [0, 0, 0], max: [1, 2, 3] },
  selectionErrors: [{
    selection: "EMPTY",
    code: "empty_selection",
    message: "Selection 'EMPTY' matched no surface.",
  }],
};

function handler(
  partialDependencies: Parameters<typeof createMeshPreflightTools>[0] = {},
) {
  const tool = createMeshPreflightTools(partialDependencies).find((candidate) =>
    candidate.name === MESH_PREFLIGHT_TOOL_NAME
  );
  if (!tool) throw new Error("Mesh preflight tool not found.");
  return tool.handler;
}

Deno.test("mesh preflight snapshots a STEP, projects bounded mesh diagnostics, and starts no solver", async () => {
  const source = await Deno.makeTempFile({ suffix: ".step" });
  const sourceText = "ISO-10303-21;\nEND-ISO-10303-21;\n";
  await Deno.writeTextFile(source, sourceText);
  let meshSnapshotPath = "";
  let meshCalls = 0;
  try {
    const result = await handler({
      meshStepPreflight: async (options) => {
        meshCalls++;
        meshSnapshotPath = options.stepPath;
        assertEquals(await Deno.readTextFile(options.stepPath), sourceText);
        assertEquals(options.meshSizeMm, 2);
        assertEquals(options.elementOrder, 2);
        assertEquals(options.selections.map((selection) => selection.name), [
          "FIXED",
          "EMPTY",
        ]);
        return structuredClone(FAKE_PREFLIGHT);
      },
    })({ ...structuredClone(INPUT), step_path: source }) as {
      content: string;
      structuredContent: Record<string, unknown>;
    };

    assertEquals(meshCalls, 1);
    assertEquals(
      result.content.includes("no CalculiX solve was started"),
      true,
    );
    const structured = result.structuredContent;
    assertEquals(structured.schemaVersion, "1.0");
    assertEquals(structured.kind, "mesh-selection-preflight");
    assertEquals(structured.boundsMm, { min: [0, 0, 0], max: [1, 2, 3] });
    assertEquals(structured.mesh, { nodes: 4, elements: 1 });
    assertEquals(structured.selections, [
      {
        name: "FIXED",
        boxMm: { min: [0, 0, 0], max: [1, 2, 3] },
        nodes: 3,
      },
      {
        name: "EMPTY",
        boxMm: { min: [8, 8, 8], max: [9, 9, 9] },
        nodes: 0,
      },
    ]);
    assertEquals(structured.errors, FAKE_PREFLIGHT.selectionErrors);
    const inputArtifact = structured.inputArtifact as Record<string, unknown>;
    assertEquals(inputArtifact.sourcePath, source);
    assertEquals("path" in inputArtifact, false);
    await assertRejects(
      () => Deno.stat(meshSnapshotPath),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(source).catch(() => {});
  }
});

Deno.test("mesh preflight rejects solver fields and invalid bounded inputs before snapshotting", async () => {
  let snapshotted = false;
  const beforeSnapshot = handler({
    snapshotStepArtifact: () => {
      snapshotted = true;
      return Promise.reject(new Error("snapshot must not run"));
    },
  });

  await assertRejects(
    async () =>
      await beforeSnapshot({
        ...structuredClone(INPUT),
        step_path: "/missing.step",
        material: {},
      }),
    OrdinaryInputError,
    "unknown input field 'material'",
  );
  assertEquals(snapshotted, false);

  await assertRejects(
    async () =>
      await beforeSnapshot({
        ...structuredClone(INPUT),
        step_path: "/missing.step",
        timeout_ms: 120_001,
      }),
    OrdinaryInputError,
    "timeout_ms",
  );
  assertEquals(snapshotted, false);
});

Deno.test("mesh preflight schema is closed at every request object level", () => {
  assertEquals(MESH_PREFLIGHT_INPUT_SCHEMA.additionalProperties, false);
  const properties = MESH_PREFLIGHT_INPUT_SCHEMA.properties;
  const selections = properties.selections as {
    items: {
      additionalProperties: boolean;
      properties: { box: { additionalProperties: boolean } };
    };
  };
  assertEquals(selections.items.additionalProperties, false);
  assertEquals(selections.items.properties.box.additionalProperties, false);
});

Deno.test("meshStepPreflight returns empty selections structurally without starting CalculiX", async () => {
  const root = await Deno.makeTempDir({ prefix: "calculix-mesh-preflight-" });
  const bin = `${root}/bin`;
  const temporary = `${root}/tmp`;
  const stepPath = `${root}/input.step`;
  const fakeGmsh = `${bin}/gmsh`;
  await Deno.mkdir(bin);
  await Deno.mkdir(temporary);
  await Deno.writeTextFile(stepPath, "ISO-10303-21;\nEND-ISO-10303-21;\n");
  await Deno.writeTextFile(
    fakeGmsh,
    [
      "#!/bin/sh",
      "printf '%s\\n' \\",
      "  '*NODE' \\",
      "  '1, 0, 0, 0' \\",
      "  '2, 2, 0, 0' \\",
      "  '3, 0, 3, 4' \\",
      "  '4, 0, 0, 4' \\",
      "  '*ELEMENT, type=C3D4, ELSET=PART' \\",
      "  '1, 1, 2, 3, 4' \\",
      "  '*NSET,NSET=FIXED' \\",
      "  '1, 2, 2' \\",
      "  '*NSET,NSET=FIXED,GENERATE' \\",
      "  '2, 4, 1' > mesh.inp",
    ].join("\n") + "\n",
  );
  await Deno.chmod(fakeGmsh, 0o755);
  const previousPath = Deno.env.get("PATH");
  const previousTemp = Deno.env.get("TMPDIR");
  const options = {
    stepPath,
    selections: [
      {
        name: "FIXED",
        box: {
          min: [0, 0, 0] as [number, number, number],
          max: [2, 3, 4] as [number, number, number],
        },
      },
      {
        name: "EMPTY",
        box: {
          min: [8, 8, 8] as [number, number, number],
          max: [9, 9, 9] as [number, number, number],
        },
      },
    ],
    meshSizeMm: 2,
    elementOrder: 1 as const,
    timeoutMs: 1_000,
  };
  try {
    Deno.env.set("PATH", `${bin}${previousPath ? `:${previousPath}` : ""}`);
    Deno.env.set("TMPDIR", temporary);
    const result = await meshStepPreflight(options);
    assertEquals(result.mesh.nodeCount, 4);
    assertEquals(result.mesh.elementCount, 1);
    assertEquals(result.mesh.nodesPerSet, { FIXED: 4 });
    assertEquals(result.bounds, { min: [0, 0, 0], max: [2, 3, 4] });
    assertEquals(
      result.selectionErrors.map((error) => ({
        selection: error.selection,
        code: error.code,
      })),
      [{ selection: "EMPTY", code: "empty_selection" }],
    );
    await assertRejects(
      () => meshStepRecorded(options),
      MeshingError,
      "'EMPTY' matched no surface",
    );
    assertEquals([...Deno.readDirSync(temporary)], []);
  } finally {
    if (previousPath === undefined) Deno.env.delete("PATH");
    else Deno.env.set("PATH", previousPath);
    if (previousTemp === undefined) Deno.env.delete("TMPDIR");
    else Deno.env.set("TMPDIR", previousTemp);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("mesh bounds are parsed from node coordinates and element continuations do not inflate counts", () => {
  const inp = [
    "*NODE",
    "1, -2, 0, 4",
    "** Gmsh comment inside the node section",
    "2, 1.5, 3, -1",
    "*ELEMENT, type=C3D10, ELSET=PART",
    "1, 1, 2, 3, 4, 5, 6, 7, 8,",
    "9, 10",
    "2, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10",
    "*NSET,NSET=FIXED",
    "1, 2",
  ].join("\n");

  assertEquals(inspectMeshNodeBounds(inp), {
    min: [-2, 0, -1],
    max: [1.5, 3, 4],
  });
  assertEquals(inspectInp(inp).nodeCount, 2);
  assertEquals(inspectInp(inp).elementCount, 2);
  assertThrows(
    () => inspectMeshNodeBounds("*NODE\n1, 0, nope, 2"),
    MeshingError,
    "non-finite",
  );
  assertThrows(
    () => inspectMeshNodeBounds("*NODE\n1, 0, 0, 0\n1, 1, 1, 1"),
    MeshingError,
    "duplicate *NODE id 1",
  );
  assertThrows(
    () => inspectInp("*NODE\n1, 0, 0, 0\n1, 1, 1, 1"),
    MeshingError,
    "duplicate *NODE id 1",
  );
});

Deno.test("mesh preflight refuses case-insensitive duplicate selection names before effects", async () => {
  await assertRejects(
    async () =>
      await handler()({
        step_path: "/unused.step",
        mesh_size_mm: 2,
        selections: [
          { name: "Fixed", box: { min: [0, 0, 0], max: [1, 1, 1] } },
          { name: "FIXED", box: { min: [2, 2, 2], max: [3, 3, 3] } },
        ],
      }),
    OrdinaryInputError,
    "unique case-insensitively",
  );
});
