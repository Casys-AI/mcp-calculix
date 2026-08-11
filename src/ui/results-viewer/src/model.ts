export interface StaticSolveResult extends Record<string, unknown> {
  schemaVersion: "2.0";
  kind: "static-solve" | "static-solve-recorded";
  inputArtifact:
    | {
      path: string;
      sourcePath: string;
      sha256: string;
      bytes: number;
    }
    | {
      uri: string;
      mimeType: "model/step";
      sha256: string;
      bytes: number;
    };
  run?: Record<string, unknown>;
  mesh: {
    nodes: number;
    elements: number;
    nodesPerSelection: Record<string, number>;
  };
  constraints: {
    fixedSelections: string[];
    loads: Array<{ selection: string; forceN: [number, number, number] }>;
  };
  metrics: {
    maxDisplacement: {
      value: number;
      unit: "mm";
      nodeId: number;
      vectorMm: [number, number, number];
    };
    maxVonMises: { value: number; unit: "MPa"; elementId: number };
  };
}

export type DisplayState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "error"; message: string }
  | { kind: "result"; result: StaticSolveResult };

export function parseStaticSolve(value: unknown): StaticSolveResult {
  const root = record(value, "structuredContent");
  if (
    root.schemaVersion !== "2.0" ||
    (root.kind !== "static-solve" && root.kind !== "static-solve-recorded")
  ) {
    throw new TypeError(
      "Expected a static-solve or static-solve-recorded result with schemaVersion 2.0.",
    );
  }
  const kind = root.kind;
  const inputArtifact = record(root.inputArtifact, "inputArtifact");
  const mesh = record(root.mesh, "mesh");
  const constraints = record(root.constraints, "constraints");
  const metrics = record(root.metrics, "metrics");
  const maxDisplacement = record(
    metrics.maxDisplacement,
    "metrics.maxDisplacement",
  );
  const maxVonMises = record(metrics.maxVonMises, "metrics.maxVonMises");
  return {
    schemaVersion: "2.0",
    kind,
    inputArtifact: kind === "static-solve"
      ? {
        path: nonEmptyString(inputArtifact.path, "inputArtifact.path"),
        sourcePath: nonEmptyString(
          inputArtifact.sourcePath,
          "inputArtifact.sourcePath",
        ),
        sha256: sha256(inputArtifact.sha256, "inputArtifact.sha256"),
        bytes: positiveInteger(inputArtifact.bytes, "inputArtifact.bytes"),
      }
      : {
        uri: recordedStepUri(inputArtifact.uri),
        mimeType: literal(
          inputArtifact.mimeType,
          "model/step",
          "inputArtifact.mimeType",
        ),
        sha256: sha256(inputArtifact.sha256, "inputArtifact.sha256"),
        bytes: positiveInteger(inputArtifact.bytes, "inputArtifact.bytes"),
      },
    ...(kind === "static-solve-recorded"
      ? { run: record(root.run, "run") }
      : {}),
    mesh: {
      nodes: positiveInteger(mesh.nodes, "mesh.nodes"),
      elements: positiveInteger(mesh.elements, "mesh.elements"),
      nodesPerSelection: positiveIntegerMap(
        mesh.nodesPerSelection,
        "mesh.nodesPerSelection",
      ),
    },
    constraints: {
      fixedSelections: strings(
        constraints.fixedSelections,
        "constraints.fixedSelections",
      ),
      loads: loads(constraints.loads),
    },
    metrics: {
      maxDisplacement: {
        value: nonNegativeNumber(
          maxDisplacement.value,
          "metrics.maxDisplacement.value",
        ),
        unit: literal(
          maxDisplacement.unit,
          "mm",
          "metrics.maxDisplacement.unit",
        ),
        nodeId: positiveInteger(
          maxDisplacement.nodeId,
          "metrics.maxDisplacement.nodeId",
        ),
        vectorMm: vector(
          maxDisplacement.vectorMm,
          "metrics.maxDisplacement.vectorMm",
        ),
      },
      maxVonMises: {
        value: nonNegativeNumber(
          maxVonMises.value,
          "metrics.maxVonMises.value",
        ),
        unit: literal(maxVonMises.unit, "MPa", "metrics.maxVonMises.unit"),
        elementId: positiveInteger(
          maxVonMises.elementId,
          "metrics.maxVonMises.elementId",
        ),
      },
    },
  };
}

function recordedStepUri(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^casys:\/\/calculix\/runs\/r-[0-9a-f-]{36}\/input\.step$/.test(value)
  ) {
    throw new TypeError(
      "inputArtifact.uri must identify a recorded input.step.",
    );
  }
  return value;
}

function sha256(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

export function toolErrorMessage(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    return "The static solve reported an error.";
  }
  const text = value.content.find((item) =>
    isRecord(item) && item.type === "text"
  )?.text;
  return typeof text === "string" && text.trim()
    ? text
    : "The static solve reported an error.";
}

function loads(
  value: unknown,
): Array<{ selection: string; forceN: [number, number, number] }> {
  if (!Array.isArray(value)) {
    throw new TypeError("constraints.loads must be an array.");
  }
  return value.map((item, index) => {
    const load = record(item, `constraints.loads[${index}]`);
    return {
      selection: nonEmptyString(
        load.selection,
        `constraints.loads[${index}].selection`,
      ),
      forceN: vector(load.forceN, `constraints.loads[${index}].forceN`),
    };
  });
}

function positiveIntegerMap(
  value: unknown,
  name: string,
): Record<string, number> {
  const input = record(value, name);
  return Object.fromEntries(
    Object.entries(input).map((
      [key, count],
    ) => [key, positiveInteger(count, `${name}.${key}`)]),
  );
}

function vector(value: unknown, name: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new TypeError(`${name} must have three values.`);
  }
  return [
    finiteNumber(value[0], `${name}[0]`),
    finiteNumber(value[1], `${name}[1]`),
    finiteNumber(value[2], `${name}[2]`),
  ];
}

function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array.`);
  return value.map((item, index) => nonEmptyString(item, `${name}[${index}]`));
}

function literal<T extends string>(
  value: unknown,
  expected: T,
  name: string,
): T {
  if (value !== expected) throw new TypeError(`${name} must be ${expected}.`);
  return expected;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return value as number;
}

function nonNegativeNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative number.`);
  }
  return value;
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be finite.`);
  }
  return value;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${name} must be an object.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
