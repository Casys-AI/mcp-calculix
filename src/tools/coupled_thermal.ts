/**
 * CalculiX coupled temperature-displacement solve tool
 *
 * Deterministic pipeline: STEP → Gmsh mesh → CalculiX
 * *COUPLED TEMPERATURE-DISPLACEMENT (steady state) → temperatures, displace-
 * ments, and von Mises stresses from the combined thermo-mechanical field.
 *
 * Analysis type: STEADY STATE.
 * Steady-state analysis does NOT require *SPECIFIC HEAT; this input is
 * intentionally absent.  If transient coupled analysis is added in the future,
 * *SPECIFIC HEAT becomes mandatory and must be declared explicitly.
 *
 * Element handling: Gmsh emits C3D4 or C3D10 elements; ccx automatically adds
 * the temperature DOF (11) to these elements for coupled analysis.  C3D8T-style
 * element names are not supported in ccx 2.21 and must not appear in the deck.
 *
 * Conductivity unit identity: 1 W/(m·K) = 1 mW/(mm·K).
 * Proof: W/(m·K) × (1000 mW/W) × (1 m / 1000 mm) = mW/(mm·K); the factors of
 * 1000 cancel exactly.  The conductivity_w_mk value is written directly into
 * *CONDUCTIVITY without any conversion factor.
 *
 * @module lib/calculix/tools/coupled_thermal
 */

import type { CalculixTool } from "./types.ts";
import {
  parseOrdinarySolveArgs,
  rejectUnknownFields,
  tightenCommonOrdinaryInputSchema,
} from "./ordinary-preflight.ts";
import { meshStep } from "../api/gmsh.ts";
import {
  assertMechanicalFixedAndLoadNodeDisjoint,
  buildCoupledThermalDeck,
  type NodalLoad,
  solveCoupledThermalDeck,
  SolveError,
  type ThermalBC,
} from "../api/ccx.ts";
import { snapshotStepArtifact } from "../api/input-artifact.ts";
import {
  COUPLED_THERMAL_SOLVE_KIND,
  COUPLED_THERMAL_SOLVE_OUTPUT_SCHEMA,
  COUPLED_THERMAL_SOLVE_SCHEMA_VERSION,
} from "../results.ts";

export const coupledThermalTools: CalculixTool[] = [
  {
    name: "calculix_solve_coupled_thermal",
    description:
      "Steady-state coupled temperature-displacement analysis on a STEP file: " +
      "mesh with Gmsh, solve with CalculiX *COUPLED TEMPERATURE-DISPLACEMENT, " +
      "return max temperature, max displacement, and max von Mises stress " +
      "from the combined thermo-mechanical field. " +
      "Thermal BCs are applied by named face selections (same bounding-box " +
      "convention as calculix_solve_static). " +
      "Conductivity unit: conductivity_w_mk is written as-is into the deck — " +
      "1 W/(m·K) = 1 mW/(mm·K) exactly (factors of 1000 cancel). " +
      "reference_temperature_c sets the zero-thermal-strain reference and is " +
      "required by ccx (applied as *INITIAL CONDITIONS). " +
      "Analysis type is STEADY STATE; *SPECIFIC HEAT is not required and is " +
      "intentionally omitted (it becomes mandatory only for transient analysis). " +
      "Mechanical loads are optional; thermal expansion is always active if " +
      "expansion_per_k > 0. " +
      "The STEP is attested with SHA-256 before any meshing starts. " +
      "Units: mm, N, MPa, °C.",
    category: "solve",
    outputSchema: COUPLED_THERMAL_SOLVE_OUTPUT_SCHEMA,
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
        conductivity_w_mk: {
          type: "number",
          exclusiveMinimum: 0,
          description: "Thermal conductivity in W/(m·K). " +
            "Unit identity: 1 W/(m·K) = 1 mW/(mm·K) exactly (1000 factors " +
            "cancel). The value is written directly into *CONDUCTIVITY. " +
            "Al 6061: 167, steel: 50, stainless steel: 16.",
        },
        expansion_per_k: {
          type: "number",
          exclusiveMinimum: 0,
          description:
            "Linear thermal expansion coefficient in 1/K (isotropic). " +
            "Al 6061: 23.6e-6, steel: 12e-6.",
        },
        reference_temperature_c: {
          type: "number",
          description: "Reference temperature in °C for zero thermal strain. " +
            "Applied as *INITIAL CONDITIONS, TYPE=TEMPERATURE — required by " +
            "ccx. Typically the ambient or pre-heating temperature.",
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
            "A selection may be in both fixed and thermal_bcs — mechanical " +
            "and thermal DOFs are independent.",
        },
        thermal_bcs: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              selection: {
                type: "string",
                description: "Selection name to apply the temperature BC",
              },
              temperature_c: {
                type: "number",
                description:
                  "Temperature in °C applied to all nodes of the selection",
              },
            },
            required: ["selection", "temperature_c"],
          },
          description: "Temperature boundary conditions by named selection. " +
            "At least two are typically needed to drive a heat flux. " +
            "Each selection may carry only one temperature BC " +
            "(duplicate selections are rejected).",
        },
        loads: {
          type: "array",
          items: {
            type: "object",
            properties: {
              selection: {
                type: "string",
                description: "Selection name carrying the mechanical load",
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
          description:
            "Optional mechanical loads (superimposed on thermal expansion)",
        },
        timeout_ms: {
          type: "number",
          description:
            "Time limit per external run (mesh, solve) in ms, default and maximum 120000.",
        },
      },
      required: [
        "step_path",
        "mesh_size_mm",
        "material",
        "conductivity_w_mk",
        "expansion_per_k",
        "reference_temperature_c",
        "selections",
        "fixed",
        "thermal_bcs",
      ],
    },
    handler: async (args) => {
      const thermalBCsRaw = Array.isArray(args.thermal_bcs)
        ? args.thermal_bcs as Array<
          { selection: string; temperature_c: number }
        >
        : [];
      for (const [index, thermalBC] of thermalBCsRaw.entries()) {
        rejectUnknownFields(
          thermalBC,
          ["selection", "temperature_c"],
          "calculix_solve_coupled_thermal",
          `thermal_bcs[${index}]`,
        );
      }
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
        toolName: "calculix_solve_coupled_thermal",
        loads: "optional",
        additionalInputFields: [
          "conductivity_w_mk",
          "expansion_per_k",
          "reference_temperature_c",
          "thermal_bcs",
        ],
        extraReferencedNames: thermalBCsRaw.map((bc) => bc.selection),
        extraReferenceRole: "fixed/thermal_bcs/loads",
      });
      const conductivityWmK = args.conductivity_w_mk as number;
      const expansionPerK = args.expansion_per_k as number;
      const referenceTemperatureC = args.reference_temperature_c as number;

      if (!(conductivityWmK > 0)) {
        throw new SolveError(
          `[calculix_solve_coupled_thermal] conductivity_w_mk must be > 0, ` +
            `got ${conductivityWmK}.`,
        );
      }
      if (!(expansionPerK > 0)) {
        throw new SolveError(
          `[calculix_solve_coupled_thermal] expansion_per_k must be > 0, ` +
            `got ${expansionPerK}.`,
        );
      }
      if (thermalBCsRaw.length === 0) {
        throw new SolveError(
          `[calculix_solve_coupled_thermal] thermal_bcs must have at least ` +
            `one entry.`,
        );
      }

      // Duplicate thermal BCs on the same selection.
      const thermalNames = thermalBCsRaw.map((bc) => bc.selection);
      const thermalDups = thermalNames.filter(
        (n, i) => thermalNames.indexOf(n) !== i,
      );
      if (thermalDups.length > 0) {
        throw new SolveError(
          `[calculix_solve_coupled_thermal] duplicate thermal_bcs selection(s): ` +
            `${thermalDups.join(", ")}.`,
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

        const thermalBCs: ThermalBC[] = thermalBCsRaw.map((bc) => ({
          selection: bc.selection,
          temperatureC: bc.temperature_c,
        }));
        const nodalLoads: NodalLoad[] = loads.map((l) => ({
          selection: l.selection,
          totalForceN: l.force_n,
        }));

        const deck = buildCoupledThermalDeck({
          inpText: mesh.inpText,
          maxNodeId: mesh.maxNodeId,
          material: { eMpa: material.e_mpa, nu: material.nu },
          conductivityWmK,
          expansionPerK,
          referenceTemperatureC,
          fixed,
          thermalBCs,
          loads: nodalLoads,
          nodesPerSet: mesh.nodesPerSet,
        });

        const result = await solveCoupledThermalDeck(deck, timeoutMs);

        const structuredContent = {
          schemaVersion: COUPLED_THERMAL_SOLVE_SCHEMA_VERSION,
          kind: COUPLED_THERMAL_SOLVE_KIND,
          inputArtifact: snapshot.artifact,
          mesh: {
            nodes: mesh.nodeCount,
            elements: mesh.elementCount,
            nodesPerSelection: mesh.nodesPerSet,
          },
          constraints: {
            fixedSelections: fixed,
            thermalBCs: thermalBCsRaw.map((bc) => ({
              selection: bc.selection,
              temperatureC: bc.temperature_c,
            })),
            loads: loads.map((load) => ({
              selection: load.selection,
              forceN: load.force_n,
            })),
          },
          material: {
            eMpa: material.e_mpa,
            nu: material.nu,
            conductivityWmK,
            expansionPerK,
            referenceTemperatureC,
          },
          metrics: {
            maxTemperature: {
              value: result.maxTemperatureC,
              unit: "degC" as const,
            },
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
            `Coupled thermal solve complete for STEP sha256:${snapshot.artifact.sha256}: ` +
            `${mesh.nodeCount} nodes, steady state: ` +
            `max temp ${result.maxTemperatureC.toFixed(1)} °C, ` +
            `max disp ${result.maxDisplacement.magnitudeMm.toFixed(4)} mm, ` +
            `max von Mises ${result.maxVonMises.mpa.toFixed(3)} MPa.`,
          structuredContent,
        };
      } finally {
        await snapshot.cleanup();
      }
    },
  },
];
tightenCommonOrdinaryInputSchema(coupledThermalTools[0].inputSchema);
