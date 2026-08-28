/**
 * CalculiX creep (*VISCO + Norton law) solve tool
 *
 * Deterministic pipeline: STEP → Gmsh mesh → CalculiX
 * *VISCO solve with Norton power-law creep → displacement and von Mises
 * stress at the END of the specified creep duration.
 *
 * Physical model: constant load applied instantaneously, held for `duration_s`
 * seconds. The reported state is the FINAL increment, not the maximum over
 * the creep history. This is deferred deformation under constant load, NOT
 * stress relaxation (which requires prescribed displacement).
 *
 * Norton law:  ε̇_creep = norton_a · σ^norton_n
 * Units: norton_a in MPa^(-norton_n) · s^(-1) (NOT SI Pa units — see below).
 *
 * Unit system: mm, N, MPa, tonne (= 1000 kg), seconds.
 * A value of norton_a correct in SI Pa^(-n) s^(-1) is off by 10^(6n):
 *   for n=3 the error is 10^18.  The caller must supply A in MPa units.
 *
 * @module lib/calculix/tools/creep
 */

import type { CalculixTool } from "./types.ts";
import {
  parseOrdinarySolveArgs,
  tightenCommonOrdinaryInputSchema,
} from "./ordinary-preflight.ts";
import { meshStep } from "../api/gmsh.ts";
import {
  assertCreepReachedRequestedDuration,
  assertMechanicalFixedAndLoadNodeDisjoint,
  buildCreepDeck,
  formatObservedTimeS,
  type NodalLoad,
  solveCreepDeck,
  SolveError,
} from "../api/ccx.ts";
import { snapshotStepArtifact } from "../api/input-artifact.ts";
import {
  CREEP_SOLVE_KIND,
  CREEP_SOLVE_OUTPUT_SCHEMA,
  CREEP_SOLVE_SCHEMA_VERSION,
} from "../results.ts";

export const creepTools: CalculixTool[] = [
  {
    name: "calculix_solve_creep",
    description:
      "Creep (*VISCO) analysis on a STEP file using the Norton power law: " +
      "mesh with Gmsh, apply constant loads, hold for duration_s seconds, " +
      "return displacement and von Mises stress AT THE END of the creep " +
      "duration (final converged increment). " +
      "Norton law: strain_rate = norton_a × stress^norton_n. " +
      "UNIT WARNING: norton_a must be in MPa^(-norton_n) s^(-1), NOT SI " +
      "Pa units. For n=3 the SI-to-MPa conversion factor is 10^18 — passing " +
      "a SI value silently produces incorrect results. " +
      "This models time-dependent deformation under constant load " +
      "(creep), NOT stress relaxation under prescribed displacement. " +
      "Faces are designated by named axis-aligned bounding boxes in mm — " +
      "same convention as calculix_solve_static. " +
      "The STEP is attested with SHA-256 before any meshing starts. " +
      "Units: mm, N, MPa, seconds.",
    category: "solve",
    outputSchema: CREEP_SOLVE_OUTPUT_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
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
            "Optional SHA-256 expected for the STEP bytes. Verified " +
            "against the private snapshot before meshing starts.",
        },
        mesh_size_mm: {
          type: "number",
          description:
            "Target element size in mm. Explicit — pick relative to the " +
            "smallest feature.",
        },
        element_order: {
          type: "number",
          enum: [1, 2],
          description:
            "1 = linear tets (fast), 2 = quadratic (better accuracy, default)",
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
            "Elastic material constants — explicit values, never a material name",
        },
        norton_a: {
          type: "number",
          exclusiveMinimum: 0,
          description: "Norton law coefficient A in MPa^(-norton_n) s^(-1). " +
            "UNIT WARNING: this is NOT SI Pa units. For n=3, converting " +
            "a SI value requires multiplying by 10^18. " +
            "The physical material parameters belong to the caller; the " +
            "fixture used A=1e-10 MPa^(-3) s^(-1) for fast convergence " +
            "only — not a real material.",
        },
        norton_n: {
          type: "number",
          exclusiveMinimum: 0,
          description:
            "Norton law exponent n (dimensionless, typically 2–8). " +
            "Creep strain rate = norton_a × stress^norton_n.",
        },
        duration_s: {
          type: "number",
          exclusiveMinimum: 0,
          description:
            "Total creep duration in seconds. Results at the end of " +
            "this interval are reported (final converged increment).",
        },
        initial_time_increment_s: {
          type: "number",
          exclusiveMinimum: 0,
          description:
            "Initial time increment in seconds. CalculiX may reduce it " +
            "if the creep strain tolerance (CETOL=1e-4 internally) is " +
            "exceeded. A reasonable choice is duration_s / 10. " +
            "Must be ≤ duration_s.",
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
                  "TOTAL force vector [fx, fy, fz] in N, distributed over " +
                  "the set's nodes. Held constant throughout the creep.",
              },
            },
            required: ["selection", "force_n"],
          },
          description:
            "Constant nodal loads applied throughout the creep duration",
        },
        timeout_ms: {
          type: "number",
          description:
            "Time limit per external run (mesh, solve) in ms, default and maximum 120000. " +
            "Refine the bounded model rather than extending native process lifetime.",
        },
      },
      required: [
        "step_path",
        "mesh_size_mm",
        "material",
        "norton_a",
        "norton_n",
        "duration_s",
        "initial_time_increment_s",
        "selections",
        "fixed",
        "loads",
      ],
    },
    handler: async (args) => {
      const {
        stepPath,
        expectedStepSha256,
        meshSizeMm,
        elementOrder,
        timeoutMs,
        material,
        selections,
        fixed,
        loads,
      } = parseOrdinarySolveArgs(args, {
        toolName: "calculix_solve_creep",
        loads: "required",
        additionalInputFields: [
          "norton_a",
          "norton_n",
          "duration_s",
          "initial_time_increment_s",
        ],
      });
      const nortonA = args.norton_a as number;
      const nortonN = args.norton_n as number;
      const durationS = args.duration_s as number;
      const initialTimeDtS = args.initial_time_increment_s as number;

      if (!(nortonA > 0)) {
        throw new SolveError(
          `[calculix_solve_creep] norton_a must be > 0, got ${nortonA}.`,
        );
      }
      if (!(nortonN > 0)) {
        throw new SolveError(
          `[calculix_solve_creep] norton_n must be > 0, got ${nortonN}.`,
        );
      }
      if (!(durationS > 0)) {
        throw new SolveError(
          `[calculix_solve_creep] duration_s must be > 0, got ${durationS}.`,
        );
      }
      if (!(initialTimeDtS > 0 && initialTimeDtS <= durationS)) {
        throw new SolveError(
          `[calculix_solve_creep] initial_time_increment_s must be in ` +
            `(0, duration_s=${durationS}], got ${initialTimeDtS}.`,
        );
      }

      const snapshot = await snapshotStepArtifact(
        stepPath,
        expectedStepSha256,
      );

      try {
        const mesh = await meshStep({
          stepPath: snapshot.artifact.path,
          selections,
          meshSizeMm,
          elementOrder,
          timeoutMs,
        });

        assertMechanicalFixedAndLoadNodeDisjoint(
          mesh.inpText,
          fixed,
          loads.map((load) => load.selection),
        );

        const nodalLoads: NodalLoad[] = loads.map((l) => ({
          selection: l.selection,
          totalForceN: l.force_n,
        }));

        const deck = buildCreepDeck({
          inpText: mesh.inpText,
          maxNodeId: mesh.maxNodeId,
          material: { eMpa: material.e_mpa, nu: material.nu },
          fixed,
          loads: nodalLoads,
          nodesPerSet: mesh.nodesPerSet,
          nortonA,
          nortonN,
          durationS,
          initialTimeDtS,
        });

        const result = await solveCreepDeck(deck, timeoutMs);
        assertCreepReachedRequestedDuration(result.observedTimeS, durationS);

        const structuredContent = {
          schemaVersion: CREEP_SOLVE_SCHEMA_VERSION,
          kind: CREEP_SOLVE_KIND,
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
          creep: { nortonA, nortonN, durationS, initialTimeDtS },
          metricsAtEnd: {
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
          content: creepSolveTextSummary({
            stepSha256: snapshot.artifact.sha256,
            nodeCount: mesh.nodeCount,
            observedTimeS: result.observedTimeS,
            maxDisplacementMm: result.maxDisplacement.magnitudeMm,
            maxVonMisesMpa: result.maxVonMises.mpa,
          }),
          structuredContent,
        };
      } finally {
        await snapshot.cleanup();
      }
    },
  },
];
tightenCommonOrdinaryInputSchema(creepTools[0].inputSchema);

export function creepSolveTextSummary(args: {
  stepSha256: string;
  nodeCount: number;
  observedTimeS: number;
  maxDisplacementMm: number;
  maxVonMisesMpa: number;
}): string {
  return `Creep solve complete for STEP sha256:${args.stepSha256}: ` +
    `${args.nodeCount} nodes, at observed t=${
      formatObservedTimeS(args.observedTimeS)
    } s: ` +
    `max disp ${args.maxDisplacementMm.toFixed(4)} mm, ` +
    `max von Mises ${args.maxVonMisesMpa.toFixed(3)} MPa.`;
}
