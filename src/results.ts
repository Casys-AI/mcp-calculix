/**
 * Strict, viewer-safe result contracts for CalculiX solves.
 *
 * Every result type has a version constant, a kind constant, a TypeScript
 * interface, and a closed JSON Schema (additionalProperties: false) that
 * rejects both missing and extra fields.
 */

export const STATIC_SOLVE_SCHEMA_VERSION = "2.0";
export const STATIC_SOLVE_KIND = "static-solve";
export const STATIC_SOLVE_RECORDED_SCHEMA_VERSION = "2.0";
export const STATIC_SOLVE_RECORDED_KIND = "static-solve-recorded";

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

/**
 * Successor contract for a static solve with durable, content-attested run
 * evidence.  The original 2.0 contract remains frozen for existing clients.
 */
const RECORDED_RUN_ID_PATTERN =
  "^r-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const RECORDED_DIGEST_PATTERN = "^[a-f0-9]{64}$";
const RECORDED_ARTIFACT_URI_PREFIX =
  "^casys://calculix/runs/r-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/";

export const RECORDED_INPUT_ARTIFACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["uri", "mimeType", "sha256", "bytes"],
  properties: {
    uri: {
      type: "string",
      pattern: `${RECORDED_ARTIFACT_URI_PREFIX}input\\.step$`,
    },
    mimeType: { const: "model/step" },
    sha256: { type: "string", pattern: RECORDED_DIGEST_PATTERN },
    bytes: { type: "integer", minimum: 1 },
  },
} as const;

function recordedArtifactSchema(
  name: string,
  mimeType: string,
  minimumBytes = 0,
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["name", "uri", "mimeType", "bytes", "sha256"],
    properties: {
      name: { const: name },
      uri: {
        type: "string",
        pattern: `${RECORDED_ARTIFACT_URI_PREFIX}${name.replace(".", "\\.")}$`,
      },
      mimeType: { const: mimeType },
      bytes: { type: "integer", minimum: minimumBytes },
      sha256: { type: "string", pattern: RECORDED_DIGEST_PATTERN },
    },
  } as const;
}

const RECORDED_ARTIFACTS_SCHEMA: Record<string, unknown> = {
  type: "array",
  minItems: 9,
  maxItems: 9,
  prefixItems: [
    recordedArtifactSchema("input.step", "model/step", 1),
    recordedArtifactSchema("request.json", "application/json"),
    recordedArtifactSchema("mesh.geo", "text/plain"),
    recordedArtifactSchema("mesh.inp", "text/plain"),
    recordedArtifactSchema("gmsh.log", "text/plain"),
    recordedArtifactSchema("job.inp", "text/plain"),
    recordedArtifactSchema("ccx.log", "text/plain"),
    recordedArtifactSchema("job.dat", "text/plain"),
    recordedArtifactSchema("result.json", "application/json"),
  ],
  items: false,
} as const;

export const RECORDED_STATIC_RUN_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "state",
    "runId",
    "requestId",
    "requestSha256",
    "inputArtifact",
    "createdAt",
    "artifacts",
  ],
  properties: {
    schemaVersion: { const: "2.0" },
    state: { const: "completed" },
    runId: { type: "string", pattern: RECORDED_RUN_ID_PATTERN },
    requestId: {
      type: "string",
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
    },
    requestSha256: { type: "string", pattern: RECORDED_DIGEST_PATTERN },
    inputArtifact: RECORDED_INPUT_ARTIFACT_SCHEMA,
    createdAt: {
      type: "string",
      pattern:
        "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$",
    },
    artifacts: RECORDED_ARTIFACTS_SCHEMA,
  },
} as const;

const RECORDED_RUN_LOOKUP_SCHEMA = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "value"],
      properties: {
        kind: { const: "run_id" },
        value: { type: "string", pattern: RECORDED_RUN_ID_PATTERN },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "value"],
      properties: {
        kind: { const: "request_id" },
        value: {
          type: "string",
          pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
        },
      },
    },
  ],
} as const;

/** Closed recovery state union; unavailable states deliberately carry no run. */
export const RECORDED_STATIC_RUN_GET_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: [
        "schemaVersion",
        "status",
        "lookup",
        "requestId",
        "runId",
        "run",
      ],
      properties: {
        schemaVersion: { const: "1.0" },
        status: { const: "completed" },
        lookup: RECORDED_RUN_LOOKUP_SCHEMA,
        requestId: {
          type: "string",
          pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
        },
        runId: { type: "string", pattern: RECORDED_RUN_ID_PATTERN },
        run: RECORDED_STATIC_RUN_OUTPUT_SCHEMA,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: [
        "schemaVersion",
        "status",
        "lookup",
        "requestId",
        "runId",
        "reason",
      ],
      properties: {
        schemaVersion: { const: "1.0" },
        status: { enum: ["dispatched", "quarantined", "evicted"] },
        lookup: RECORDED_RUN_LOOKUP_SCHEMA,
        requestId: {
          type: "string",
          pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
        },
        runId: { type: "string", pattern: RECORDED_RUN_ID_PATTERN },
        reason: { type: ["string", "null"] },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["schemaVersion", "status", "lookup"],
      properties: {
        schemaVersion: { const: "1.0" },
        status: { const: "not_found" },
        lookup: RECORDED_RUN_LOOKUP_SCHEMA,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: [
        "schemaVersion",
        "status",
        "lookup",
        "requestId",
        "reason",
      ],
      properties: {
        schemaVersion: { const: "1.0" },
        status: { const: "outcome_unknown" },
        lookup: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "value"],
          properties: {
            kind: { const: "request_id" },
            value: {
              type: "string",
              pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
            },
          },
        },
        requestId: {
          type: "string",
          pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
        },
        reason: { type: "string", minLength: 1 },
      },
    },
  ],
} as const;

export const STATIC_SOLVE_RECORDED_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "kind",
    "inputArtifact",
    "mesh",
    "constraints",
    "metrics",
    "run",
  ],
  properties: {
    schemaVersion: { const: STATIC_SOLVE_RECORDED_SCHEMA_VERSION },
    kind: { const: STATIC_SOLVE_RECORDED_KIND },
    inputArtifact: RECORDED_INPUT_ARTIFACT_SCHEMA,
    mesh: STATIC_SOLVE_OUTPUT_SCHEMA.properties.mesh,
    constraints: STATIC_SOLVE_OUTPUT_SCHEMA.properties.constraints,
    metrics: STATIC_SOLVE_OUTPUT_SCHEMA.properties.metrics,
    run: RECORDED_STATIC_RUN_OUTPUT_SCHEMA,
  },
} as const;

// ── Modal (*FREQUENCY) result ─────────────────────────────────────────────────

export const MODAL_SOLVE_SCHEMA_VERSION = "1.0";
export const MODAL_SOLVE_KIND = "modal-solve";

export interface ModalSolveResult {
  schemaVersion: typeof MODAL_SOLVE_SCHEMA_VERSION;
  kind: typeof MODAL_SOLVE_KIND;
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
  };
  material: {
    eMpa: number;
    nu: number;
    densityKgM3: number;
  };
  metrics: {
    frequenciesHz: readonly number[];
  };
}

/** Closed MCP tool output schema for a modal solve. */
export const MODAL_SOLVE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "kind",
    "inputArtifact",
    "mesh",
    "constraints",
    "material",
    "metrics",
  ],
  properties: {
    schemaVersion: { const: MODAL_SOLVE_SCHEMA_VERSION },
    kind: { const: MODAL_SOLVE_KIND },
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
      required: ["fixedSelections"],
      properties: {
        fixedSelections: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
      },
    },
    material: {
      type: "object",
      additionalProperties: false,
      required: ["eMpa", "nu", "densityKgM3"],
      properties: {
        eMpa: { type: "number", exclusiveMinimum: 0 },
        nu: { type: "number", exclusiveMinimum: 0 },
        densityKgM3: { type: "number", exclusiveMinimum: 0 },
      },
    },
    metrics: {
      type: "object",
      additionalProperties: false,
      required: ["frequenciesHz"],
      properties: {
        frequenciesHz: {
          type: "array",
          items: { type: "number", minimum: 0 },
          minItems: 1,
        },
      },
    },
  },
} as const;

// ── Buckling (*BUCKLE) result ─────────────────────────────────────────────────

export const BUCKLE_SOLVE_SCHEMA_VERSION = "1.0";
export const BUCKLE_SOLVE_KIND = "buckle-solve";

export interface BuckleSolveResult {
  schemaVersion: typeof BUCKLE_SOLVE_SCHEMA_VERSION;
  kind: typeof BUCKLE_SOLVE_KIND;
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
    loadFactors: readonly number[];
  };
}

/** Closed MCP tool output schema for a buckling solve. */
export const BUCKLE_SOLVE_OUTPUT_SCHEMA = {
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
    schemaVersion: { const: BUCKLE_SOLVE_SCHEMA_VERSION },
    kind: { const: BUCKLE_SOLVE_KIND },
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
      required: ["loadFactors"],
      properties: {
        loadFactors: {
          type: "array",
          items: { type: "number" },
          minItems: 1,
        },
      },
    },
  },
} as const;

// ── Creep (*VISCO + Norton law) result ────────────────────────────────────────

export const CREEP_SOLVE_SCHEMA_VERSION = "1.0";
export const CREEP_SOLVE_KIND = "creep-solve";

export interface CreepSolveResult {
  schemaVersion: typeof CREEP_SOLVE_SCHEMA_VERSION;
  kind: typeof CREEP_SOLVE_KIND;
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
  creep: {
    nortonA: number;
    nortonN: number;
    durationS: number;
    initialTimeDtS: number;
  };
  /**
   * State at the end of the creep duration (last converged increment).
   * This is NOT the global maximum over all increments — it is the final state.
   */
  metricsAtEnd: {
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

/** Closed MCP tool output schema for a creep solve. */
export const CREEP_SOLVE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "kind",
    "inputArtifact",
    "mesh",
    "constraints",
    "creep",
    "metricsAtEnd",
  ],
  properties: {
    schemaVersion: { const: CREEP_SOLVE_SCHEMA_VERSION },
    kind: { const: CREEP_SOLVE_KIND },
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
    creep: {
      type: "object",
      additionalProperties: false,
      required: ["nortonA", "nortonN", "durationS", "initialTimeDtS"],
      properties: {
        nortonA: { type: "number", exclusiveMinimum: 0 },
        nortonN: { type: "number", exclusiveMinimum: 0 },
        durationS: { type: "number", exclusiveMinimum: 0 },
        initialTimeDtS: { type: "number", exclusiveMinimum: 0 },
      },
    },
    metricsAtEnd: {
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

// ── Coupled temperature-displacement result ───────────────────────────────────

export const COUPLED_THERMAL_SOLVE_SCHEMA_VERSION = "1.0";
export const COUPLED_THERMAL_SOLVE_KIND = "coupled-thermal-solve";

export interface CoupledThermalSolveResult {
  schemaVersion: typeof COUPLED_THERMAL_SOLVE_SCHEMA_VERSION;
  kind: typeof COUPLED_THERMAL_SOLVE_KIND;
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
    thermalBCs: readonly {
      selection: string;
      temperatureC: number;
    }[];
    loads: readonly {
      selection: string;
      forceN: readonly [number, number, number];
    }[];
  };
  material: {
    eMpa: number;
    nu: number;
    conductivityWmK: number;
    expansionPerK: number;
    referenceTemperatureC: number;
  };
  /** Steady-state result: maximum values across all nodes and elements. */
  metrics: {
    maxTemperature: {
      value: number;
      unit: "degC";
    };
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

/** Closed MCP tool output schema for a coupled thermal solve. */
export const COUPLED_THERMAL_SOLVE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "kind",
    "inputArtifact",
    "mesh",
    "constraints",
    "material",
    "metrics",
  ],
  properties: {
    schemaVersion: { const: COUPLED_THERMAL_SOLVE_SCHEMA_VERSION },
    kind: { const: COUPLED_THERMAL_SOLVE_KIND },
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
      required: ["fixedSelections", "thermalBCs", "loads"],
      properties: {
        fixedSelections: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
        thermalBCs: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["selection", "temperatureC"],
            properties: {
              selection: { type: "string", minLength: 1 },
              temperatureC: { type: "number" },
            },
          },
          minItems: 1,
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
    material: {
      type: "object",
      additionalProperties: false,
      required: [
        "eMpa",
        "nu",
        "conductivityWmK",
        "expansionPerK",
        "referenceTemperatureC",
      ],
      properties: {
        eMpa: { type: "number", exclusiveMinimum: 0 },
        nu: { type: "number", exclusiveMinimum: 0 },
        conductivityWmK: { type: "number", exclusiveMinimum: 0 },
        expansionPerK: { type: "number", exclusiveMinimum: 0 },
        referenceTemperatureC: { type: "number" },
      },
    },
    metrics: {
      type: "object",
      additionalProperties: false,
      required: ["maxTemperature", "maxDisplacement", "maxVonMises"],
      properties: {
        maxTemperature: {
          type: "object",
          additionalProperties: false,
          required: ["value", "unit"],
          properties: {
            value: { type: "number" },
            unit: { const: "degC" },
          },
        },
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
