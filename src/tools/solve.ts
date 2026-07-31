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
import { type FaceSelection, meshStep } from "../api/gmsh.ts";
import { buildDeck, type NodalLoad, solveDeck } from "../api/ccx.ts";
import {
  STATIC_SOLVE_KIND,
  STATIC_SOLVE_OUTPUT_SCHEMA,
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
      "from a name. Requires gmsh and ccx on PATH (apt install gmsh " +
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

      const mesh = await meshStep({
        stepPath: args.step_path as string,
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
          `Static solve complete: ${structuredContent.mesh.nodes} nodes, max displacement ${structuredContent.metrics.maxDisplacement.value} mm, max von Mises ${structuredContent.metrics.maxVonMises.value} MPa.`,
        structuredContent,
      };
    },
  },
];
