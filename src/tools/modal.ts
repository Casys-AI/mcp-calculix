/**
 * CalculiX modal (eigenfrequency) solve tool
 *
 * Deterministic pipeline: STEP → Gmsh mesh → CalculiX
 * *FREQUENCY solve → eigenfrequencies in Hz.  The same inputs always
 * produce the same answer.
 *
 * Key constraints relative to the static solve:
 * - density_kg_m3 is REQUIRED — there is no inertia without mass density.
 *   The value is converted to t/mm³ by the exact factor 1e-12 and written
 *   with uppercase-E notation to satisfy CalculiX's number parser.
 * - No loads: eigenfrequency analysis is a free-vibration problem (no
 *   excitation force).  Boundary conditions still apply.
 * - Output: frequencies in Hz, ascending order.
 *
 * Unit system: mm, N, MPa, tonne (= 1000 kg), seconds.
 * Density unit: 1 kg/m³ = 1e-12 t/mm³ → frequencies come out in Hz.
 *
 * @module lib/calculix/tools/modal
 */

import type { CalculixTool } from "./types.ts";
import {
  parseOrdinarySolveArgs,
  tightenCommonOrdinaryInputSchema,
} from "./ordinary-preflight.ts";
import { meshStep } from "../api/gmsh.ts";
import { buildModalDeck, SolveError, solveModalDeck } from "../api/ccx.ts";
import { snapshotStepArtifact } from "../api/input-artifact.ts";
import {
  MODAL_SOLVE_KIND,
  MODAL_SOLVE_OUTPUT_SCHEMA,
  MODAL_SOLVE_SCHEMA_VERSION,
} from "../results.ts";

export const modalTools: CalculixTool[] = [
  {
    name: "calculix_solve_modal",
    description:
      "Eigenfrequency (*FREQUENCY) analysis on a STEP file: mesh with " +
      "Gmsh, solve with CalculiX, return natural frequencies in Hz. " +
      "Faces are designated by named axis-aligned bounding boxes in mm — " +
      "same convention as calculix_solve_static. " +
      "density_kg_m3 is REQUIRED: there is no inertia without mass density " +
      "(Al 6061: 2700, steel: 7850). The value is converted to t/mm³ by the " +
      "exact factor 1e-12 (1 kg/m³ = 1e-12 t/mm³ in the mm/N/MPa/t/s " +
      "unit system) so that the frequencies come out in Hz. " +
      "No loads: this is a free-vibration solve. " +
      "The STEP is attested with SHA-256 before any meshing starts. " +
      "Units: mm, N, MPa; frequencies: Hz.",
    category: "solve",
    outputSchema: MODAL_SOLVE_OUTPUT_SCHEMA,
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
            "1 = linear tets (fast, stiffer frequencies), 2 = quadratic " +
            "(better accuracy, default)",
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
        density_kg_m3: {
          type: "number",
          exclusiveMinimum: 0,
          description:
            "Mass density in kg/m³ — REQUIRED for frequency analysis. " +
            "Al 6061: 2700, steel: 7850. Converted internally to t/mm³ " +
            "by factor 1e-12 (exact). No default — density that looks " +
            "like a value is not one.",
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
            "Selection names whose nodes are fully fixed (all translations). " +
            "At least one fixed selection avoids rigid-body modes.",
        },
        n_modes: {
          type: "integer",
          minimum: 1,
          maximum: 30,
          description: "Number of eigenfrequencies to compute (default 6). " +
            "Must not exceed the unconstrained DOF count of the mesh " +
            "(= 3 × unconstrained nodes); requesting more modes than DOF " +
            "causes ccx to return fewer without error.",
        },
        timeout_ms: {
          type: "number",
          description:
            "Time limit per external run (mesh, solve) in ms, default 120000. " +
            "Eigenvalue solves on fine meshes scale super-linearly with DOF count.",
        },
      },
      required: [
        "step_path",
        "mesh_size_mm",
        "material",
        "density_kg_m3",
        "selections",
        "fixed",
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
      } = parseOrdinarySolveArgs(args, {
        toolName: "calculix_solve_modal",
        loads: "none",
      });
      const nModes = (args.n_modes as number) ?? 6;
      const densityKgM3 = args.density_kg_m3 as number;

      // density_kg_m3 is required — validate early, before any subprocess.
      if (typeof densityKgM3 !== "number" || !(densityKgM3 > 0)) {
        throw new SolveError(
          `[calculix_solve_modal] density_kg_m3 is required and must be > 0 ` +
            `(Al 6061: 2700, steel: 7850). Got: ${densityKgM3}`,
        );
      }

      // n_modes guard (schema constrains 1..30 but guard survives serialisation).
      if (
        !Number.isInteger(nModes) || nModes < 1 || nModes > 30
      ) {
        throw new SolveError(
          `[calculix_solve_modal] n_modes must be an integer in [1, 30], ` +
            `got ${nModes}.`,
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

        const deck = buildModalDeck({
          inpText: mesh.inpText,
          maxNodeId: mesh.maxNodeId,
          material: { eMpa: material.e_mpa, nu: material.nu },
          densityKgM3,
          fixed,
          nModes,
        });

        const result = await solveModalDeck(deck, timeoutMs);

        const structuredContent = {
          schemaVersion: MODAL_SOLVE_SCHEMA_VERSION,
          kind: MODAL_SOLVE_KIND,
          inputArtifact: snapshot.artifact,
          mesh: {
            nodes: mesh.nodeCount,
            elements: mesh.elementCount,
            nodesPerSelection: mesh.nodesPerSet,
          },
          constraints: { fixedSelections: fixed },
          material: {
            eMpa: material.e_mpa,
            nu: material.nu,
            densityKgM3,
          },
          metrics: { frequenciesHz: result.frequenciesHz },
        };
        return {
          content:
            `Modal solve complete for STEP sha256:${snapshot.artifact.sha256}: ` +
            `${result.frequenciesHz.length} modes, ` +
            `f1=${result.frequenciesHz[0]?.toFixed(3)} Hz` +
            (result.frequenciesHz[1] !== undefined
              ? `, f2=${result.frequenciesHz[1].toFixed(3)} Hz`
              : "") +
            ".",
          structuredContent,
        };
      } finally {
        await snapshot.cleanup();
      }
    },
  },
];
tightenCommonOrdinaryInputSchema(modalTools[0].inputSchema);
