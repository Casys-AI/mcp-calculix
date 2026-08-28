/**
 * CalculiX mesh/selection preflight.
 *
 * This tool stops after Gmsh has produced a cleaned mesh. It has no material,
 * boundary-condition, load, deck, ccx, proof, or durable-evidence path.
 */

import type { CalculixTool } from "./types.ts";
import {
  MAX_MESH_PREFLIGHT_SELECTIONS,
  MAX_MESH_PREFLIGHT_TIMEOUT_MS,
  parseMeshPreflightArgs,
} from "./ordinary-preflight.ts";
import {
  type MeshPreflightResult as GmshMeshPreflightResult,
  meshStepPreflight,
} from "../api/gmsh.ts";
import { snapshotStepArtifact } from "../api/input-artifact.ts";
import {
  MESH_PREFLIGHT_KIND,
  MESH_PREFLIGHT_OUTPUT_SCHEMA,
  MESH_PREFLIGHT_SCHEMA_VERSION,
  type MeshPreflightResult,
} from "../results.ts";

export const MESH_PREFLIGHT_TOOL_NAME = "calculix_mesh_preflight";

const VECTOR3_INPUT_SCHEMA = {
  type: "array",
  items: { type: "number" },
  minItems: 3,
  maxItems: 3,
} as const;

/** Closed schema because this is not a permissive generic Gmsh command. */
export const MESH_PREFLIGHT_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["step_path", "mesh_size_mm", "selections"],
  properties: {
    step_path: {
      type: "string",
      minLength: 1,
      description: "Absolute path to the STEP file in the server filesystem.",
    },
    expected_step_sha256: {
      type: "string",
      pattern: "^[a-fA-F0-9]{64}$",
      description:
        "Optional SHA-256 required for the exact private STEP snapshot before Gmsh starts.",
    },
    mesh_size_mm: {
      type: "number",
      exclusiveMinimum: 0,
      description:
        "Explicit target tetrahedral element size in mm; no heuristic default is selected.",
    },
    element_order: {
      type: "integer",
      enum: [1, 2],
      default: 2,
      description: "1 = C3D4, 2 = C3D10 (the default).",
    },
    timeout_ms: {
      type: "integer",
      minimum: 1,
      maximum: MAX_MESH_PREFLIGHT_TIMEOUT_MS,
      default: 120_000,
      description:
        "Gmsh time limit in ms. This preflight is capped to keep its ephemeral work bounded.",
    },
    selections: {
      type: "array",
      minItems: 1,
      maxItems: MAX_MESH_PREFLIGHT_SELECTIONS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "box"],
        properties: {
          name: {
            type: "string",
            pattern: "^[A-Za-z][A-Za-z0-9_]{0,60}$",
            description: "Abaqus NSET-compatible selection name.",
          },
          box: {
            type: "object",
            additionalProperties: false,
            required: ["min", "max"],
            properties: {
              min: VECTOR3_INPUT_SCHEMA,
              max: VECTOR3_INPUT_SCHEMA,
            },
          },
        },
      },
      description:
        "Named axis-aligned surface-selection boxes in the STEP coordinate system, in mm.",
    },
  },
} as const;

export interface MeshPreflightToolDependencies {
  snapshotStepArtifact: typeof snapshotStepArtifact;
  meshStepPreflight: typeof meshStepPreflight;
}

const DEFAULT_DEPENDENCIES: MeshPreflightToolDependencies = {
  snapshotStepArtifact,
  meshStepPreflight,
};

/** Build a mesh-only preflight tool, with small seams for focused tests. */
export function createMeshPreflightTools(
  partialDependencies: Partial<MeshPreflightToolDependencies> = {},
): CalculixTool[] {
  const dependencies: MeshPreflightToolDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...partialDependencies,
  };
  return [{
    name: MESH_PREFLIGHT_TOOL_NAME,
    description:
      "Mesh and inspect named STEP face selections with Gmsh before a " +
      "CalculiX solve. Returns the private STEP snapshot identity, generated " +
      "mesh-node bounds in mm, mesh counts, node count per requested " +
      "selection, and structured empty-selection diagnostics. It never " +
      "starts ccx, builds a solver deck, accepts material/loads/fixed " +
      "conditions, returns an FEA observation, or creates durable resources.",
    category: "solve",
    inputSchema: MESH_PREFLIGHT_INPUT_SCHEMA,
    outputSchema: MESH_PREFLIGHT_OUTPUT_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (args) => {
      const input = parseMeshPreflightArgs(args, MESH_PREFLIGHT_TOOL_NAME);
      const snapshot = await dependencies.snapshotStepArtifact(
        input.stepPath,
        input.expectedStepSha256,
        MESH_PREFLIGHT_TOOL_NAME,
      );
      try {
        const preflight = await dependencies.meshStepPreflight({
          stepPath: snapshot.artifact.path,
          selections: input.selections,
          meshSizeMm: input.meshSizeMm,
          elementOrder: input.elementOrder,
          timeoutMs: input.timeoutMs,
        });
        const structuredContent = structuredResult(
          input,
          snapshot.artifact,
          preflight,
        );
        return {
          content: preflight.selectionErrors.length === 0
            ? `Mesh preflight complete for STEP sha256:${snapshot.artifact.sha256}: ${structuredContent.mesh.nodes} nodes, ${structuredContent.mesh.elements} elements.`
            : `Mesh preflight completed with ${preflight.selectionErrors.length} empty selection diagnostic(s); no CalculiX solve was started.`,
          structuredContent,
        };
      } finally {
        await snapshot.cleanup();
      }
    },
  }];
}

function structuredResult(
  input: ReturnType<typeof parseMeshPreflightArgs>,
  artifact: {
    sourcePath: string;
    sha256: string;
    bytes: number;
  },
  preflight: GmshMeshPreflightResult,
): MeshPreflightResult {
  return {
    schemaVersion: MESH_PREFLIGHT_SCHEMA_VERSION,
    kind: MESH_PREFLIGHT_KIND,
    // The private snapshot path is intentionally omitted: it is gone when
    // this result returns and must not be treated as a reusable file handle.
    inputArtifact: {
      sourcePath: artifact.sourcePath,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
    },
    boundsMm: preflight.bounds,
    mesh: {
      nodes: preflight.mesh.nodeCount,
      elements: preflight.mesh.elementCount,
    },
    selections: input.selections.map((selection) => ({
      name: selection.name,
      boxMm: selection.box,
      nodes: preflight.mesh.nodesPerSet[selection.name] ?? 0,
    })),
    errors: preflight.selectionErrors,
  };
}

export const meshPreflightTools: CalculixTool[] = createMeshPreflightTools();
