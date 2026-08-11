/**
 * CalculiX solve tool
 *
 * One tool, one deterministic pipeline: STEP → Gmsh mesh (named face
 * selections by bounding box) → CalculiX linear static solve → max
 * displacement and max von Mises stress. No intermediate state to manage —
 * the same inputs always produce the same answer.
 *
 * Everything physical is explicit: mesh size, element order, material
 * constants, which faces are fixed, which carry which force. Nothing is
 * looked up from a material name or defaulted from a heuristic.
 *
 * @module lib/calculix/tools/solve
 */

import type { CalculixTool } from "./types.ts";
import { type FaceSelection, meshStep, meshStepRecorded } from "../api/gmsh.ts";
import {
  buildDeck,
  type NodalLoad,
  parseDat,
  solveDeck,
  solveDeckRecorded,
} from "../api/ccx.ts";
import { snapshotStepArtifact } from "../api/input-artifact.ts";
import {
  artifactUri,
  type CalculixRunStore,
  canonicalJson,
  type RecordedStaticExecutionIdentity,
  type RecordedStaticRun,
  resolveRecordedStaticRequest,
} from "../runs.ts";
import {
  RECORDED_STATIC_RUN_GET_OUTPUT_SCHEMA,
  STATIC_SOLVE_KIND,
  STATIC_SOLVE_OUTPUT_SCHEMA,
  STATIC_SOLVE_RECORDED_KIND,
  STATIC_SOLVE_RECORDED_OUTPUT_SCHEMA,
  STATIC_SOLVE_RECORDED_SCHEMA_VERSION,
  STATIC_SOLVE_SCHEMA_VERSION,
} from "../results.ts";

export const CALCULIX_RESULTS_VIEWER_URI = "ui://mcp-calculix/results-viewer";

export const solveTools: CalculixTool[] = [
  {
    name: "calculix_solve_static",
    description:
      "Linear static FEA on a STEP file (e.g. from build123d_export): mesh " +
      "with Gmsh, solve with CalculiX, return max displacement and max von " +
      "Mises stress. Faces are designated by named axis-aligned bounding " +
      "boxes in mm — every surface enclosed in a box joins that named set; " +
      "get the part's bounding box from build123d_execute first. Fully fixed " +
      "supports and total nodal forces only (no pressure loads yet). All " +
      "physical inputs are explicit: material constants are never looked up " +
      "from a name. The STEP is copied into a private snapshot and its " +
      "computed SHA-256 is returned; pass expected_step_sha256 to require " +
      "a specific upstream export. Requires gmsh and ccx on PATH (apt install gmsh " +
      "calculix-ccx). Units: mm, N, MPa.",
    category: "solve",
    outputSchema: STATIC_SOLVE_OUTPUT_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { ui: { resourceUri: CALCULIX_RESULTS_VIEWER_URI } },
    inputSchema: {
      type: "object",
      properties: {
        step_path: {
          type: "string",
          description: "Absolute path to the STEP file to analyse",
        },
        expected_step_sha256: {
          type: "string",
          pattern: "^[a-fA-F0-9]{64}$",
          description:
            "Optional SHA-256 expected for the STEP bytes. CalculiX copies " +
            "the source into a private snapshot, hashes that copy, and " +
            "rejects a mismatch before starting Gmsh or ccx.",
        },
        mesh_size_mm: {
          type: "number",
          description:
            "Target element size in mm. Explicit — pick relative to the " +
            "smallest feature (e.g. 3 for a 60 mm bracket with 5 mm walls).",
        },
        element_order: {
          type: "number",
          enum: [1, 2],
          description:
            "1 = linear tets (fast, stiff), 2 = quadratic (better stresses, " +
            "default)",
        },
        material: {
          type: "object",
          properties: {
            e_mpa: {
              type: "number",
              description:
                "Young's modulus in MPa (Al 6061: 70000, steel: 210000)",
            },
            nu: {
              type: "number",
              description: "Poisson's ratio (Al: 0.33, steel: 0.30)",
            },
          },
          required: ["e_mpa", "nu"],
          description:
            "Material constants — explicit values, never a material name",
        },
        selections: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description:
                  "Set name (letters/digits/underscore, becomes an NSET)",
              },
              box: {
                type: "object",
                properties: {
                  min: {
                    type: "array",
                    items: { type: "number" },
                    minItems: 3,
                    maxItems: 3,
                  },
                  max: {
                    type: "array",
                    items: { type: "number" },
                    minItems: 3,
                    maxItems: 3,
                  },
                },
                required: ["min", "max"],
                description:
                  "Axis-aligned box in mm enclosing the target surfaces",
              },
            },
            required: ["name", "box"],
          },
          description: "Named face selections by bounding box",
        },
        fixed: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
          description:
            "Selection names whose nodes are fully fixed (all translations)",
        },
        loads: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              selection: {
                type: "string",
                description: "Selection name carrying the load",
              },
              force_n: {
                type: "array",
                items: { type: "number" },
                minItems: 3,
                maxItems: 3,
                description:
                  "TOTAL force vector [fx, fy, fz] in N, distributed over the set's nodes",
              },
            },
            required: ["selection", "force_n"],
          },
          description: "Nodal loads (total force per selection)",
        },
        timeout_ms: {
          type: "number",
          description:
            "Time limit per external run (mesh, solve) in ms, default 120000",
        },
      },
      required: [
        "step_path",
        "mesh_size_mm",
        "material",
        "selections",
        "fixed",
        "loads",
      ],
    },
    handler: async (args) => {
      const selections = args.selections as FaceSelection[];
      const fixed = args.fixed as string[];
      const loads = args.loads as Array<
        { selection: string; force_n: [number, number, number] }
      >;
      const timeoutMs = (args.timeout_ms as number) ?? 120_000;

      // Referenced names must exist before any subprocess runs.
      const known = new Set(selections.map((s) => s.name));
      for (const name of [...fixed, ...loads.map((l) => l.selection)]) {
        if (!known.has(name)) {
          throw new Error(
            `[calculix_solve_static] '${name}' is referenced in fixed/loads ` +
              `but not declared in selections (${[...known].join(", ")}).`,
          );
        }
      }
      const overlap = fixed.filter((f) => loads.some((l) => l.selection === f));
      if (overlap.length > 0) {
        throw new Error(
          `[calculix_solve_static] ${overlap.join(", ")} is both fixed and ` +
            `loaded — a fully fixed node ignores its load, which is almost ` +
            `certainly not what you meant.`,
        );
      }

      const snapshot = await snapshotStepArtifact(
        args.step_path as string,
        args.expected_step_sha256 as string | undefined,
      );

      try {
        const mesh = await meshStep({
          stepPath: snapshot.artifact.path,
          selections,
          meshSizeMm: args.mesh_size_mm as number,
          elementOrder: ((args.element_order as number) ?? 2) as 1 | 2,
          timeoutMs,
        });

        const materialInput = args.material as { e_mpa: number; nu: number };
        const nodalLoads: NodalLoad[] = loads.map((l) => ({
          selection: l.selection,
          totalForceN: l.force_n,
        }));

        const deck = buildDeck({
          inpText: mesh.inpText,
          maxNodeId: mesh.maxNodeId,
          material: { eMpa: materialInput.e_mpa, nu: materialInput.nu },
          fixed,
          loads: nodalLoads,
          nodesPerSet: mesh.nodesPerSet,
        });

        const result = await solveDeck(deck, timeoutMs);

        const structuredContent = {
          schemaVersion: STATIC_SOLVE_SCHEMA_VERSION,
          kind: STATIC_SOLVE_KIND,
          inputArtifact: snapshot.artifact,
          mesh: {
            nodes: mesh.nodeCount,
            elements: mesh.elementCount,
            nodesPerSelection: mesh.nodesPerSet,
          },
          constraints: {
            fixedSelections: fixed,
            loads: loads.map((load) => ({
              selection: load.selection,
              forceN: load.force_n,
            })),
          },
          metrics: {
            maxDisplacement: {
              value: result.maxDisplacement.magnitudeMm,
              unit: "mm" as const,
              nodeId: result.maxDisplacement.nodeId,
              vectorMm: result.maxDisplacement.vectorMm,
            },
            maxVonMises: {
              value: result.maxVonMises.mpa,
              unit: "MPa" as const,
              elementId: result.maxVonMises.elementId,
            },
          },
        };
        return {
          content:
            `Static solve complete for STEP sha256:${snapshot.artifact.sha256}: ${structuredContent.mesh.nodes} nodes, max displacement ${structuredContent.metrics.maxDisplacement.value} mm, max von Mises ${structuredContent.metrics.maxVonMises.value} MPa.`,
          structuredContent,
        };
      } finally {
        await snapshot.cleanup();
      }
    },
  },
];

/**
 * Explicit successor tools for durable evidence.  `calculix_solve_static`
 * remains frozen at its 2.0 result schema, so existing clients do not receive
 * an unexpected field or change their execution contract.
 */
export function createRecordedStaticTools(
  runStore: CalculixRunStore,
  partialDependencies: Partial<RecordedStaticToolDependencies> = {},
): CalculixTool[] {
  const dependencies: RecordedStaticToolDependencies = {
    ...DEFAULT_RECORDED_DEPENDENCIES,
    ...partialDependencies,
  };
  const inputSchema = recordedStaticInputSchema();
  return [
    {
      name: "calculix_solve_static_recorded",
      description: "Linear static FEA with the same physical contract as " +
        "calculix_solve_static, plus a durable, content-attested run ledger. " +
        "The result exposes closed casys:// artifact resources for the exact " +
        "canonical request, exact input.step, mesh.geo, cleaned mesh.inp, job.inp, Gmsh/" +
        "CalculiX diagnostics, job.dat and normalized result.json. It reports " +
        "physical observations only; it never produces a requirement verdict.",
      category: "solve",
      inputSchema,
      outputSchema: STATIC_SOLVE_RECORDED_OUTPUT_SCHEMA,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async (args) => {
        // This validation is pure: defaults are fixed before the durable
        // request_id + digest election, but it never probes the local host.
        const preflight = resolveRecordedStaticRequest(
          args,
          PRE_EXECUTION_IDENTITY,
        );
        const preflightJson = canonicalJson(preflight.value) + "\n";
        const decision = await runStore.claimPreflightRequest(
          preflight.requestId,
          preflightJson,
        );
        if (decision.outcome === "completed") {
          return await recordedRunResult(runStore, decision.run);
        }
        let claim = decision.claim;
        let validated: ReturnType<typeof resolveRecordedStaticRequest>;
        let requestJson: string;
        try {
          // Only the durable winner observes local executable versions. It
          // then seals the observed identity and full effective request before
          // any snapshot, Gmsh, or CalculiX effect can begin.
          const executionIdentity = await dependencies
            .resolveExecutionIdentity();
          // Re-resolve from the frozen pure request rather than the mutable
          // handler argument, so the post-probe seal cannot drift from the
          // request that won durable ownership.
          validated = resolveRecordedStaticRequest(
            preflight.value,
            executionIdentity,
          );
          requestJson = canonicalJson(validated.value) + "\n";
          claim = await runStore.sealClaim(claim, requestJson);
        } catch (error) {
          await runStore.quarantineClaim(
            claim,
            `execution identity or request seal failed: ${errorMessage(error)}`,
          ).catch(() => {});
          throw error;
        }
        const { selections, fixed, loads, timeoutMs } = validated;
        let snapshot: Awaited<ReturnType<typeof snapshotStepArtifact>>;
        try {
          snapshot = await dependencies.snapshotStepArtifact(
            validated.stepPath,
            validated.expectedStepSha256,
          );
        } catch (error) {
          await runStore.quarantineClaim(
            claim,
            `input snapshot failed: ${errorMessage(error)}`,
          );
          throw error;
        }
        try {
          let inputStep: Uint8Array;
          let recordedMesh: Awaited<ReturnType<typeof meshStepRecorded>>;
          let recordedSolve: Awaited<ReturnType<typeof solveDeckRecorded>>;
          let deck: string;
          let normalizedResult: Record<string, unknown>;
          try {
            inputStep = await Deno.readFile(snapshot.artifact.path);
            recordedMesh = await dependencies.meshStepRecorded({
              stepPath: snapshot.artifact.path,
              selections,
              meshSizeMm: validated.meshSizeMm,
              elementOrder: validated.elementOrder,
              timeoutMs,
            });
            if (
              recordedMesh.artifacts.inputStepSha256 !==
                snapshot.artifact.sha256 ||
              recordedMesh.artifacts.inputStepBytes !== snapshot.artifact.bytes
            ) {
              throw new Error(
                "Gmsh private input.step bytes do not match the sealed STEP snapshot.",
              );
            }
            const nodalLoads: NodalLoad[] = loads.map((load) => ({
              selection: load.selection,
              totalForceN: load.force_n,
            }));
            deck = buildDeck({
              inpText: recordedMesh.mesh.inpText,
              maxNodeId: recordedMesh.mesh.maxNodeId,
              material: {
                eMpa: validated.material.e_mpa,
                nu: validated.material.nu,
              },
              fixed,
              loads: nodalLoads,
              nodesPerSet: recordedMesh.mesh.nodesPerSet,
            });
            recordedSolve = await dependencies.solveDeckRecorded(
              deck,
              timeoutMs,
            );
            const parsedDat = parseDat(recordedSolve.datText);
            if (!sameSolveResult(recordedSolve.result, parsedDat)) {
              throw new Error(
                "CalculiX adapter result does not exactly reproduce its job.dat output.",
              );
            }
            normalizedResult = staticStructuredContent({
              inputArtifact: {
                uri: artifactUri(claim.runId, "input.step"),
                mimeType: "model/step",
                sha256: snapshot.artifact.sha256,
                bytes: snapshot.artifact.bytes,
              },
              mesh: recordedMesh.mesh,
              fixed,
              loads,
              result: parsedDat,
              schemaVersion: STATIC_SOLVE_RECORDED_SCHEMA_VERSION,
              kind: STATIC_SOLVE_RECORDED_KIND,
            });
          } catch (error) {
            await runStore.quarantineClaim(
              claim,
              `native execution failed: ${errorMessage(error)}`,
            );
            throw error;
          }
          const run = await runStore.completeClaim(claim, {
            requestJson,
            inputArtifact: {
              sha256: snapshot.artifact.sha256,
              bytes: snapshot.artifact.bytes,
            },
            inputStep,
            meshGeo: recordedMesh.artifacts.geoText,
            meshInp: recordedMesh.artifacts.cleanedInpText,
            gmshDiagnostics: recordedMesh.artifacts.diagnostics,
            jobInp: deck,
            ccxDiagnostics: recordedSolve.diagnostics,
            jobDat: recordedSolve.datText,
            resultJson: canonicalJson(normalizedResult) + "\n",
          });
          return recordedRunResultFromNormalized(run, normalizedResult);
        } finally {
          await snapshot.cleanup();
        }
      },
    },
    {
      name: "calculix_run_get",
      description:
        "Read the immutable ledger of a recorded CalculiX static run. This is " +
        "read-only recovery for a lost acknowledgement; use its closed artifact " +
        "URIs with resources/read to retrieve independently rehashed exact text.",
      category: "solve",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          run_id: {
            type: "string",
            pattern: "^r-[0-9a-f-]{36}$",
            description:
              "Stable run identity returned by calculix_solve_static_recorded",
          },
          request_id: {
            type: "string",
            pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
            description:
              "Original request_id, for recovery when the ACK lost its run_id",
          },
        },
        minProperties: 1,
        maxProperties: 1,
      },
      outputSchema: RECORDED_STATIC_RUN_GET_OUTPUT_SCHEMA,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: (args) => {
        const runId = args.run_id;
        const requestId = args.request_id;
        if (typeof runId === "string" && typeof requestId === "string") {
          throw new TypeError("Provide exactly one of run_id or request_id.");
        }
        if (typeof runId !== "string" && typeof requestId !== "string") {
          throw new TypeError("Provide exactly one of run_id or request_id.");
        }
        const lookup = typeof runId === "string"
          ? { kind: "run_id" as const, value: runId }
          : { kind: "request_id" as const, value: requestId as string };
        const outcome = runStore.lookupRun(lookup);
        if (outcome.status === "completed") runStore.republish(outcome.run);
        return {
          content: outcome.status === "completed"
            ? `Recorded CalculiX run ${outcome.runId}: ${outcome.run.artifacts.length} attested artifacts.`
            : `Recorded CalculiX run lookup is ${outcome.status}.`,
          structuredContent: outcome,
        };
      },
    },
  ];
}

function staticStructuredContent(args: {
  inputArtifact: Record<string, unknown>;
  mesh: Awaited<ReturnType<typeof meshStep>>;
  fixed: string[];
  loads: Array<{ selection: string; force_n: [number, number, number] }>;
  result: Awaited<ReturnType<typeof solveDeck>>;
  schemaVersion: string;
  kind: string;
}) {
  return {
    schemaVersion: args.schemaVersion,
    kind: args.kind,
    inputArtifact: args.inputArtifact,
    mesh: {
      nodes: args.mesh.nodeCount,
      elements: args.mesh.elementCount,
      nodesPerSelection: args.mesh.nodesPerSet,
    },
    constraints: {
      fixedSelections: args.fixed,
      loads: args.loads.map((load) => ({
        selection: load.selection,
        forceN: load.force_n,
      })),
    },
    metrics: {
      maxDisplacement: {
        value: args.result.maxDisplacement.magnitudeMm,
        unit: "mm" as const,
        nodeId: args.result.maxDisplacement.nodeId,
        vectorMm: args.result.maxDisplacement.vectorMm,
      },
      maxVonMises: {
        value: args.result.maxVonMises.mpa,
        unit: "MPa" as const,
        elementId: args.result.maxVonMises.elementId,
      },
    },
  };
}

async function recordedRunResult(
  runStore: CalculixRunStore,
  run: RecordedStaticRun,
) {
  runStore.republish(run);
  return recordedRunResultFromNormalized(
    run,
    await runStore.readNormalizedResult(run.runId),
  );
}

function recordedRunResultFromNormalized(
  run: RecordedStaticRun,
  normalizedResult: Record<string, unknown>,
) {
  const structuredContent = {
    ...normalizedResult,
    run: {
      ...run,
    },
  };
  const mesh = normalizedResult.mesh as { nodes?: number } | undefined;
  const metrics = normalizedResult.metrics as {
    maxDisplacement?: { value?: number };
    maxVonMises?: { value?: number };
  } | undefined;
  return {
    content:
      `Recorded static solve ${run.runId} complete: ${
        mesh?.nodes ?? "unknown"
      } nodes, ` +
      `max displacement ${metrics?.maxDisplacement?.value ?? "unknown"} mm, ` +
      `max von Mises ${metrics?.maxVonMises?.value ?? "unknown"} MPa.`,
    structuredContent,
  };
}

export interface RecordedStaticToolDependencies {
  snapshotStepArtifact: typeof snapshotStepArtifact;
  meshStepRecorded: typeof meshStepRecorded;
  solveDeckRecorded: typeof solveDeckRecorded;
  resolveExecutionIdentity: () => Promise<RecordedStaticExecutionIdentity>;
}

const DEFAULT_RECORDED_DEPENDENCIES: RecordedStaticToolDependencies = {
  snapshotStepArtifact,
  meshStepRecorded,
  solveDeckRecorded,
  resolveExecutionIdentity: resolveExecutionIdentity,
};

const PRE_EXECUTION_IDENTITY: RecordedStaticExecutionIdentity = {
  schema_version: "1.0",
  server: { package: "@casys/mcp-calculix", version: "preflight" },
  method: { id: "calculix_solve_static_recorded", version: "1.0" },
  lowering: { id: "calculix.static.abaqus-deck", version: "1.0" },
  engines: {
    gmsh: { command: "gmsh", version: "preflight" },
    ccx: { command: "ccx", version: "preflight" },
  },
  image: { status: "unattested" },
};

/** Observe executable versions; image digests are intentionally not invented. */
async function resolveExecutionIdentity(): Promise<
  RecordedStaticExecutionIdentity
> {
  const [gmsh, ccx] = await Promise.all([
    executableVersion("gmsh", ["--version"]),
    executableVersion("ccx", ["-v"]),
  ]);
  return {
    schema_version: "1.0",
    server: { package: "@casys/mcp-calculix", version: "0.6.0" },
    method: { id: "calculix_solve_static_recorded", version: "1.0" },
    lowering: { id: "calculix.static.abaqus-deck", version: "1.0" },
    engines: {
      gmsh: { command: "gmsh", version: gmsh },
      ccx: { command: "ccx", version: ccx },
    },
    image: { status: "unattested" },
  };
}

async function executableVersion(
  command: "gmsh" | "ccx",
  args: string[],
): Promise<string> {
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command(command, {
      args,
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch (error) {
    throw new Error(
      `Cannot attest ${command} version before execution: ${
        errorMessage(error)
      }`,
    );
  }
  const text = new TextDecoder().decode(output.stdout) +
    new TextDecoder().decode(output.stderr);
  const version = text.trim().replaceAll(/\s+/g, " ");
  // `ccx -v` deliberately exits 201 after printing its version on Ubuntu's
  // CalculiX 2.21 package; acceptance is based on the observed version text,
  // not a fictional successful status. Gmsh's normal probe must exit cleanly.
  const validExit = command === "ccx"
    ? /\bversion\s+[0-9]/i.test(version)
    : output.success;
  if (!validExit || !version || version.length > 128) {
    throw new Error(`Cannot attest ${command} version before execution.`);
  }
  return version;
}

function sameSolveResult(
  left: Awaited<ReturnType<typeof solveDeckRecorded>>["result"],
  right: Awaited<ReturnType<typeof solveDeckRecorded>>["result"],
): boolean {
  return left.maxDisplacement.magnitudeMm ===
      right.maxDisplacement.magnitudeMm &&
    left.maxDisplacement.nodeId === right.maxDisplacement.nodeId &&
    canonicalJson(left.maxDisplacement.vectorMm) ===
      canonicalJson(right.maxDisplacement.vectorMm) &&
    left.maxVonMises.mpa === right.maxVonMises.mpa &&
    left.maxVonMises.elementId === right.maxVonMises.elementId;
}

function recordedStaticInputSchema(): Record<string, unknown> {
  const schema = closeObjectSchemas(structuredClone(solveTools[0].inputSchema));
  const properties = schema.properties as Record<string, unknown>;
  properties.step_path = {
    ...(properties.step_path as Record<string, unknown>),
    minLength: 1,
  };
  properties.expected_step_sha256 = {
    ...(properties.expected_step_sha256 as Record<string, unknown>),
    description:
      "Required SHA-256 of the exact STEP bytes. The durable request claim is written before snapshotting; the private copy must match this identity before Gmsh starts.",
  };
  properties.mesh_size_mm = {
    ...(properties.mesh_size_mm as Record<string, unknown>),
    exclusiveMinimum: 0,
  };
  properties.element_order = {
    ...(properties.element_order as Record<string, unknown>),
    type: "integer",
  };
  properties.timeout_ms = {
    ...(properties.timeout_ms as Record<string, unknown>),
    type: "integer",
    minimum: 1,
  };
  const material = properties.material as Record<string, unknown>;
  const materialProperties = material.properties as Record<string, unknown>;
  materialProperties.e_mpa = {
    ...(materialProperties.e_mpa as Record<string, unknown>),
    exclusiveMinimum: 0,
  };
  materialProperties.nu = {
    ...(materialProperties.nu as Record<string, unknown>),
    exclusiveMinimum: 0,
    exclusiveMaximum: 0.5,
  };
  const selections = properties.selections as Record<string, unknown>;
  const selectionItem = selections.items as Record<string, unknown>;
  const selectionProperties = selectionItem.properties as Record<
    string,
    unknown
  >;
  selectionProperties.name = {
    ...(selectionProperties.name as Record<string, unknown>),
    pattern: "^[A-Za-z][A-Za-z0-9_]{0,60}$",
  };
  const fixed = properties.fixed as Record<string, unknown>;
  fixed.items = {
    ...(fixed.items as Record<string, unknown>),
    pattern: "^[A-Za-z][A-Za-z0-9_]{0,60}$",
  };
  const loads = properties.loads as Record<string, unknown>;
  const loadItem = loads.items as Record<string, unknown>;
  const loadProperties = loadItem.properties as Record<string, unknown>;
  loadProperties.selection = {
    ...(loadProperties.selection as Record<string, unknown>),
    pattern: "^[A-Za-z][A-Za-z0-9_]{0,60}$",
  };
  properties.request_id = {
    type: "string",
    pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
    description:
      "Caller-generated attempt identity. Retrying the same canonical request with this id returns the original recorded run without re-executing; reuse with different input is rejected.",
  };
  schema.required = [
    ...(schema.required as string[]),
    "expected_step_sha256",
    "request_id",
  ];
  return schema;
}

function closeObjectSchemas(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Expected an object JSON Schema.");
  }
  const schema = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(schema)) {
    if (Array.isArray(child)) {
      schema[key] = child.map((item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? closeObjectSchemas(item)
          : item
      );
    } else if (child && typeof child === "object") {
      schema[key] = closeObjectSchemas(child);
    }
  }
  if (schema.type === "object" && schema.additionalProperties === undefined) {
    schema.additionalProperties = false;
  }
  return schema;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
