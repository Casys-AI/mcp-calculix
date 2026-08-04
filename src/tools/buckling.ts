/**
 * CalculiX buckling (linear eigenvalue) solve tool
 *
 * One tool, two-step deterministic pipeline: STEP → Gmsh mesh →
 * CalculiX *STATIC (builds geometric stiffness) → *BUCKLE (finds critical
 * load factors).
 *
 * The critical load for mode i is:  P_crit = load_factor_i × applied_load.
 * A load_factor < 1 means the applied load already exceeds the critical load.
 *
 * Inputs follow the same face-selection convention as calculix_solve_static.
 * Loads are required (buckling is meaningless without a reference preload).
 *
 * @module lib/calculix/tools/buckling
 */

import type { CalculixTool } from "./types.ts";
import { type FaceSelection, meshStep } from "../api/gmsh.ts";
import {
  buildBuckleDeck,
  type NodalLoad,
  solveBuckleDeck,
} from "../api/ccx.ts";
import { snapshotStepArtifact } from "../api/input-artifact.ts";
import {
  BUCKLE_SOLVE_KIND,
  BUCKLE_SOLVE_OUTPUT_SCHEMA,
  BUCKLE_SOLVE_SCHEMA_VERSION,
} from "../results.ts";

export const buckleTools: CalculixTool[] = [
  {
    name: "calculix_solve_buckling",
    description:
      "Linear buckling (*BUCKLE) analysis on a STEP file: mesh with " +
      "Gmsh, solve with CalculiX, return critical load factors. " +
      "Two-step solve: step 1 (*STATIC) builds the geometric stiffness " +
      "matrix under the applied loads; step 2 (*BUCKLE) finds eigenvalues λ " +
      "such that the structure buckles at P_crit = λ × applied_load. " +
      "Faces are designated by named axis-aligned bounding boxes in mm — " +
      "same convention as calculix_solve_static. " +
      "Loads are REQUIRED: buckling is defined relative to a reference " +
      "preload. A factor < 1 means the applied load already exceeds the " +
      "critical buckling load. " +
      "The STEP is attested with SHA-256 before any meshing starts. " +
      "Units: mm, N, MPa.",
    category: "solve",
    outputSchema: BUCKLE_SOLVE_OUTPUT_SCHEMA,
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
                  "TOTAL force vector [fx, fy, fz] in N, distributed over " +
                  "the set's nodes",
              },
            },
            required: ["selection", "force_n"],
          },
          description: "Reference loads for the static preload step. " +
            "The critical load for mode i = load_factor_i × these loads.",
        },
        n_modes: {
          type: "integer",
          minimum: 1,
          maximum: 30,
          description: "Number of buckling modes to compute (default 2). " +
            "Mode 1 is the lowest critical load factor.",
        },
        timeout_ms: {
          type: "number",
          description:
            "Time limit per external run (mesh, solve) in ms, default 120000.",
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
      const nModes = (args.n_modes as number) ?? 2;

      // Validate selection references before any subprocess runs.
      const known = new Set(selections.map((s) => s.name));
      for (const name of [...fixed, ...loads.map((l) => l.selection)]) {
        if (!known.has(name)) {
          throw new Error(
            `[calculix_solve_buckling] '${name}' is referenced in fixed/loads ` +
              `but not declared in selections (${[...known].join(", ")}).`,
          );
        }
      }
      const overlap = fixed.filter((f) => loads.some((l) => l.selection === f));
      if (overlap.length > 0) {
        throw new Error(
          `[calculix_solve_buckling] ${overlap.join(", ")} is both fixed and ` +
            `loaded — a fully fixed node ignores its load.`,
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

        const deck = buildBuckleDeck({
          inpText: mesh.inpText,
          maxNodeId: mesh.maxNodeId,
          material: { eMpa: materialInput.e_mpa, nu: materialInput.nu },
          fixed,
          loads: nodalLoads,
          nodesPerSet: mesh.nodesPerSet,
          nModes,
        });

        const result = await solveBuckleDeck(deck, timeoutMs);

        const structuredContent = {
          schemaVersion: BUCKLE_SOLVE_SCHEMA_VERSION,
          kind: BUCKLE_SOLVE_KIND,
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
          metrics: { loadFactors: result.loadFactors },
        };
        return {
          content:
            `Buckling solve complete for STEP sha256:${snapshot.artifact.sha256}: ` +
            `${result.loadFactors.length} modes, ` +
            `factor_1=${result.loadFactors[0]?.toFixed(3)}` +
            (result.loadFactors[1] !== undefined
              ? `, factor_2=${result.loadFactors[1].toFixed(3)}`
              : "") +
            ". P_crit = factor × applied_load; factor < 1 means applied " +
            "load already exceeds critical.",
          structuredContent,
        };
      } finally {
        await snapshot.cleanup();
      }
    },
  },
];
