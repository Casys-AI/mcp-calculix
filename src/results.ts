/** Strict, viewer-safe result contract for one CalculiX static solve. */

export const STATIC_SOLVE_SCHEMA_VERSION = "1.0";
export const STATIC_SOLVE_KIND = "static-solve";

export interface StaticSolveResult {
  schemaVersion: typeof STATIC_SOLVE_SCHEMA_VERSION;
  kind: typeof STATIC_SOLVE_KIND;
  inputArtifact: {
    path: string;
    sourcePath: string;
    sha256: string;
    bytes: number;
  };
  mesh: {
    nodes: number;
    elements: number;
    nodesPerSelection: Record<string, number>;
  };
  constraints: {
    fixedSelections: readonly string[];
    loads: readonly {
      selection: string;
      forceN: readonly [number, number, number];
    }[];
  };
  metrics: {
    maxDisplacement: {
      value: number;
      unit: "mm";
      nodeId: number;
      vectorMm: readonly [number, number, number];
    };
    maxVonMises: {
      value: number;
      unit: "MPa";
      elementId: number;
    };
  };
}

/** Closed MCP tool output schema: no files, requirement verdicts, or extras. */
export const STATIC_SOLVE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "kind",
    "inputArtifact",
    "mesh",
    "constraints",
    "metrics",
  ],
  properties: {
    schemaVersion: { const: STATIC_SOLVE_SCHEMA_VERSION },
    kind: { const: STATIC_SOLVE_KIND },
    inputArtifact: {
      type: "object",
      additionalProperties: false,
      required: ["path", "sourcePath", "sha256", "bytes"],
      properties: {
        path: { type: "string", minLength: 1 },
        sourcePath: { type: "string", minLength: 1 },
        sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        bytes: { type: "integer", minimum: 1 },
      },
    },
    mesh: {
      type: "object",
      additionalProperties: false,
      required: ["nodes", "elements", "nodesPerSelection"],
      properties: {
        nodes: { type: "integer", minimum: 1 },
        elements: { type: "integer", minimum: 1 },
        nodesPerSelection: {
          type: "object",
          additionalProperties: { type: "integer", minimum: 1 },
        },
      },
    },
    constraints: {
      type: "object",
      additionalProperties: false,
      required: ["fixedSelections", "loads"],
      properties: {
        fixedSelections: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
        loads: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["selection", "forceN"],
            properties: {
              selection: { type: "string", minLength: 1 },
              forceN: {
                type: "array",
                items: { type: "number" },
                minItems: 3,
                maxItems: 3,
              },
            },
          },
        },
      },
    },
    metrics: {
      type: "object",
      additionalProperties: false,
      required: ["maxDisplacement", "maxVonMises"],
      properties: {
        maxDisplacement: {
          type: "object",
          additionalProperties: false,
          required: ["value", "unit", "nodeId", "vectorMm"],
          properties: {
            value: { type: "number", minimum: 0 },
            unit: { const: "mm" },
            nodeId: { type: "integer", minimum: 1 },
            vectorMm: {
              type: "array",
              items: { type: "number" },
              minItems: 3,
              maxItems: 3,
            },
          },
        },
        maxVonMises: {
          type: "object",
          additionalProperties: false,
          required: ["value", "unit", "elementId"],
          properties: {
            value: { type: "number", minimum: 0 },
            unit: { const: "MPa" },
            elementId: { type: "integer", minimum: 1 },
          },
        },
      },
    },
  },
} as const;
