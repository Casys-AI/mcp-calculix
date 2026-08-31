import {
  assertRecordedResultMatchesRun,
  type CalculixIsolatedStaticResult,
  type CalculixRecordedRun,
  type CalculixRecordedStaticResult,
  type CalculixViewerSessionAnchor,
  type CalculixViewerSessionBasis,
  type CalculixViewerSessionProvenance,
  parseCalculixRecordedResultDocument,
  parseCalculixRecordedRun,
  parseCalculixRecordedStaticResult,
  parseCalculixViewerSession,
} from "../../../viewer-session.ts";

export interface OrdinaryStaticSolveResult extends Record<string, unknown> {
  readonly schemaVersion: "2.0";
  readonly kind: "static-solve";
  readonly inputArtifact: {
    readonly path: string;
    readonly sourcePath: string;
    readonly sha256: string;
    readonly bytes: number;
  };
  readonly mesh: StaticMesh;
  readonly constraints: StaticConstraints;
  readonly metrics: StaticMetrics;
}

export type StaticSolveResult =
  | OrdinaryStaticSolveResult
  | CalculixRecordedStaticResult;

export interface DigitalThreadStaticProofViewResult
  extends Record<string, unknown> {
  readonly schemaVersion: "calculix-isolated-static-result/1.0";
  readonly kind: "digital-thread-static-proof";
  readonly authority: Extract<
    CalculixViewerSessionProvenance,
    { kind: "digital-thread-operation" }
  >;
  readonly viewerSession: {
    readonly anchor: CalculixViewerSessionAnchor;
    readonly basis: CalculixViewerSessionBasis;
  };
  readonly inputArtifact: {
    readonly uri: string;
    readonly mimeType: "model/step";
    readonly sha256: string;
    readonly bytes: number;
  };
  readonly mesh: StaticMesh;
  readonly constraints: StaticConstraints;
  readonly metrics: StaticMetrics;
}

export type StaticResultsViewData =
  | StaticSolveResult
  | DigitalThreadStaticProofViewResult;

export interface StaticMesh {
  readonly nodes: number;
  readonly elements: number;
  readonly nodesPerSelection: Readonly<Record<string, number>>;
}

export interface StaticConstraints {
  readonly fixedSelections: readonly string[];
  readonly loads: readonly {
    readonly selection: string;
    readonly forceN: readonly [number, number, number];
  }[];
}

export interface StaticMetrics {
  readonly maxDisplacement: {
    readonly value: number;
    readonly unit: "mm";
    readonly nodeId: number;
    readonly vectorMm: readonly [number, number, number];
  };
  readonly maxVonMises: {
    readonly value: number;
    readonly unit: "MPa";
    readonly elementId: number;
  };
}

export type DisplayState =
  | { readonly kind: "loading" }
  | { readonly kind: "empty" }
  | { readonly kind: "error"; readonly message: string }
  | {
    readonly kind: "unresolved";
    readonly status: "dispatched" | "outcome_unknown" | "unresolved";
    readonly reason: string | null;
  }
  | {
    readonly kind: "unavailable";
    readonly status:
      | "quarantined"
      | "evicted"
      | "not_found"
      | "unavailable";
    readonly reason: string | null;
  }
  | { readonly kind: "result"; readonly result: StaticResultsViewData };

export type RecordedRunLookup =
  | {
    readonly schemaVersion: "1.0";
    readonly status: "completed";
    readonly lookup: RecordedLookupIdentity;
    readonly requestId: string;
    readonly runId: string;
    readonly run: CalculixRecordedRun;
  }
  | {
    readonly schemaVersion: "1.0";
    readonly status: "dispatched" | "quarantined" | "evicted";
    readonly lookup: RecordedLookupIdentity;
    readonly requestId: string;
    readonly runId: string;
    readonly reason: string | null;
  }
  | {
    readonly schemaVersion: "1.0";
    readonly status: "not_found";
    readonly lookup: RecordedLookupIdentity;
  }
  | {
    readonly schemaVersion: "1.0";
    readonly status: "outcome_unknown";
    readonly lookup: { readonly kind: "request_id"; readonly value: string };
    readonly requestId: string;
    readonly reason: string;
  };

export type RecordedLookupIdentity =
  | { readonly kind: "run_id"; readonly value: string }
  | { readonly kind: "request_id"; readonly value: string };

export interface ViewerResourceReader {
  (uri: string): Promise<unknown>;
}

/** Parse either ordinary or recorded direct solve output, with closed fields. */
export function parseStaticSolve(value: unknown): StaticSolveResult {
  const root = record(value, "structuredContent");
  if (root.kind === "static-solve-recorded") {
    return parseCalculixRecordedStaticResult(root);
  }
  exactKeys(root, [
    "schemaVersion",
    "kind",
    "inputArtifact",
    "mesh",
    "constraints",
    "metrics",
  ], "structuredContent");
  if (root.schemaVersion !== "2.0" || root.kind !== "static-solve") {
    throw new TypeError(
      "Expected a static-solve or static-solve-recorded result with schemaVersion 2.0.",
    );
  }
  const inputArtifact = exactRecord(
    root.inputArtifact,
    ["path", "sourcePath", "sha256", "bytes"],
    "inputArtifact",
  );
  const observations = parseObservations(root, "structuredContent");
  return {
    schemaVersion: "2.0",
    kind: "static-solve",
    inputArtifact: {
      path: nonEmptyString(inputArtifact.path, "inputArtifact.path"),
      sourcePath: nonEmptyString(
        inputArtifact.sourcePath,
        "inputArtifact.sourcePath",
      ),
      sha256: sha256(inputArtifact.sha256, "inputArtifact.sha256"),
      bytes: positiveInteger(inputArtifact.bytes, "inputArtifact.bytes"),
    },
    ...observations,
  };
}

/** Parse the closed recovery union without relying on human-facing text. */
export function parseRecordedRunLookup(value: unknown): RecordedRunLookup {
  const root = record(value, "calculix_run_get structuredContent");
  literal(root.schemaVersion, "1.0", "calculix_run_get.schemaVersion");
  if (root.status === "completed") {
    exactKeys(root, [
      "schemaVersion",
      "status",
      "lookup",
      "requestId",
      "runId",
      "run",
    ], "calculix_run_get structuredContent");
    const run = parseCalculixRecordedRun(root.run);
    const requestId = requestIdValue(
      root.requestId,
      "calculix_run_get.requestId",
    );
    const runId = runIdValue(root.runId, "calculix_run_get.runId");
    const lookup = lookupIdentity(root.lookup);
    if (run.requestId !== requestId || run.runId !== runId) {
      throw new TypeError(
        "calculix_run_get completed identity differs from its run ledger.",
      );
    }
    assertLookupMatches(lookup, requestId, runId);
    return {
      schemaVersion: "1.0",
      status: "completed",
      lookup,
      requestId,
      runId,
      run,
    };
  }
  if (
    root.status === "dispatched" ||
    root.status === "quarantined" ||
    root.status === "evicted"
  ) {
    exactKeys(root, [
      "schemaVersion",
      "status",
      "lookup",
      "requestId",
      "runId",
      "reason",
    ], "calculix_run_get structuredContent");
    const lookup = lookupIdentity(root.lookup);
    const requestId = requestIdValue(
      root.requestId,
      "calculix_run_get.requestId",
    );
    const runId = runIdValue(root.runId, "calculix_run_get.runId");
    assertLookupMatches(lookup, requestId, runId);
    return {
      schemaVersion: "1.0",
      status: root.status,
      lookup,
      requestId,
      runId,
      reason: nullableString(root.reason, "calculix_run_get.reason"),
    };
  }
  if (root.status === "not_found") {
    exactKeys(
      root,
      ["schemaVersion", "status", "lookup"],
      "calculix_run_get structuredContent",
    );
    return {
      schemaVersion: "1.0",
      status: "not_found",
      lookup: lookupIdentity(root.lookup),
    };
  }
  if (root.status === "outcome_unknown") {
    exactKeys(root, [
      "schemaVersion",
      "status",
      "lookup",
      "requestId",
      "reason",
    ], "calculix_run_get structuredContent");
    const lookup = lookupIdentity(root.lookup);
    if (lookup.kind !== "request_id") {
      throw new TypeError(
        "calculix_run_get outcome_unknown requires a request_id lookup.",
      );
    }
    const requestId = requestIdValue(
      root.requestId,
      "calculix_run_get.requestId",
    );
    if (lookup.value !== requestId) {
      throw new TypeError(
        "calculix_run_get lookup differs from its request identity.",
      );
    }
    return {
      schemaVersion: "1.0",
      status: "outcome_unknown",
      lookup,
      requestId,
      reason: nonEmptyString(root.reason, "calculix_run_get.reason"),
    };
  }
  throw new TypeError("calculix_run_get returned an unsupported status.");
}

/**
 * Reopen a completed lookup through its exact result.json MCP resource.
 * This path has no solver/tool callback: it only reads and rehashes the
 * immutable resource named by the already validated ledger.
 */
export async function hydrateRecordedRunLookup(
  value: unknown,
  readResource: ViewerResourceReader,
): Promise<DisplayState> {
  const lookup = parseRecordedRunLookup(value);
  if (lookup.status === "dispatched" || lookup.status === "outcome_unknown") {
    return {
      kind: "unresolved",
      status: lookup.status,
      reason: lookup.reason,
    };
  }
  if (
    lookup.status === "quarantined" ||
    lookup.status === "evicted" ||
    lookup.status === "not_found"
  ) {
    return {
      kind: "unavailable",
      status: lookup.status,
      reason: "reason" in lookup ? lookup.reason : null,
    };
  }
  if (lookup.status !== "completed") {
    throw new TypeError(
      "calculix_run_get status was not exhaustively handled.",
    );
  }
  const artifact = lookup.run.artifacts.find((item) =>
    item.name === "result.json"
  );
  if (!artifact) {
    throw new TypeError("The completed run has no exact result.json artifact.");
  }
  const response = await readResource(artifact.uri);
  const text = await verifiedTextResource(response, artifact);
  let valueFromResource: unknown;
  try {
    valueFromResource = JSON.parse(text);
  } catch (error) {
    throw new TypeError(
      `Recorded result.json is invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const document = parseCalculixRecordedResultDocument(valueFromResource);
  assertRecordedResultMatchesRun(document, lookup.run);
  return { kind: "result", result: { ...document, run: lookup.run } };
}

/** Normalize direct tool notifications, including read-only run reopening. */
export async function displayStateFromToolResult(
  value: unknown,
  readResource: ViewerResourceReader,
): Promise<DisplayState> {
  const result = record(value, "tool result");
  if (result.isError === true) {
    return { kind: "error", message: toolErrorMessage(result) };
  }
  const structured = result.structuredContent !== undefined
    ? (isRecord(result.structuredContent)
      ? result.structuredContent
      : undefined)
    : jsonTextFallback(result.content);
  if (structured === undefined) return { kind: "empty" };
  try {
    return { kind: "result", result: parseStaticSolve(structured) };
  } catch (solveError) {
    try {
      return await hydrateRecordedRunLookup(structured, readResource);
    } catch (lookupError) {
      throw new TypeError(
        `Unsupported CalculiX viewer result: ${errorMessage(solveError)}; ${
          errorMessage(lookupError)
        }`,
      );
    }
  }
}

/** Preserve App-owned availability states and map only available proof data. */
export async function displayStateFromViewerSession(
  value: unknown,
): Promise<DisplayState> {
  const session = await parseCalculixViewerSession(value);
  if (session.projection.status === "unresolved") {
    return {
      kind: "unresolved",
      status: "unresolved",
      reason: session.projection.reason,
    };
  }
  if (session.projection.status === "unavailable") {
    return {
      kind: "unavailable",
      status: "unavailable",
      reason: session.projection.reason,
    };
  }
  if (session.provenance.kind === "mcp-calculix-recorded-run") {
    if (session.projection.result.schemaVersion !== "2.0") {
      throw new TypeError(
        "A fleet CalculiX session must contain a recorded mcp-calculix result.",
      );
    }
    return { kind: "result", result: session.projection.result };
  }
  if (
    session.projection.result.schemaVersion !==
      "calculix-isolated-static-result/1.0"
  ) {
    throw new TypeError(
      "A Digital Thread @3 session must contain an isolated result.",
    );
  }
  return {
    kind: "result",
    result: isolatedProofView(
      session.projection.result,
      session.provenance,
      session.anchor,
      session.basis,
    ),
  };
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

function jsonTextFallback(
  content: unknown,
): Record<string, unknown> | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    if (
      !isRecord(item) || item.type !== "text" || typeof item.text !== "string"
    ) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(item.text);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Human-readable summaries remain valid text blocks; try the next block.
    }
  }
  return undefined;
}

function isolatedProofView(
  result: CalculixIsolatedStaticResult,
  provenance: Extract<
    CalculixViewerSessionProvenance,
    { kind: "digital-thread-operation" }
  >,
  anchor: CalculixViewerSessionAnchor,
  basis: CalculixViewerSessionBasis,
): DigitalThreadStaticProofViewResult {
  return {
    schemaVersion: "calculix-isolated-static-result/1.0",
    kind: "digital-thread-static-proof",
    authority: provenance,
    viewerSession: { anchor, basis },
    inputArtifact: {
      uri: provenance.inputArtifact.uri,
      mimeType: "model/step",
      sha256: result.inputArtifact.sha256,
      bytes: result.inputArtifact.byteCount,
    },
    mesh: result.mesh,
    constraints: result.constraints,
    metrics: {
      maxDisplacement: result.metrics.maximumDisplacement,
      maxVonMises: result.metrics.maximumVonMises,
    },
  };
}

async function verifiedTextResource(
  value: unknown,
  artifact: CalculixRecordedRun["artifacts"][number],
): Promise<string> {
  const response = record(value, "resources/read result");
  if (!Array.isArray(response.contents) || response.contents.length !== 1) {
    throw new TypeError("resources/read must return exactly one result.json.");
  }
  const content = record(response.contents[0], "resources/read contents[0]");
  if (
    content.uri !== artifact.uri ||
    content.mimeType !== artifact.mimeType ||
    typeof content.text !== "string"
  ) {
    throw new TypeError(
      "resources/read result does not match the recorded result.json resource.",
    );
  }
  const bytes = new TextEncoder().encode(content.text);
  if (bytes.byteLength !== artifact.bytes) {
    throw new TypeError("Recorded result.json byte count changed.");
  }
  const digest = await sha256Hex(bytes);
  if (digest !== artifact.sha256) {
    throw new TypeError("Recorded result.json SHA-256 changed.");
  }
  return content.text;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const exact = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(exact).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", exact);
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function parseObservations(
  root: Record<string, unknown>,
  name: string,
): {
  mesh: StaticMesh;
  constraints: StaticConstraints;
  metrics: StaticMetrics;
} {
  const mesh = exactRecord(
    root.mesh,
    ["nodes", "elements", "nodesPerSelection"],
    `${name}.mesh`,
  );
  const constraints = exactRecord(
    root.constraints,
    ["fixedSelections", "loads"],
    `${name}.constraints`,
  );
  const metrics = exactRecord(
    root.metrics,
    ["maxDisplacement", "maxVonMises"],
    `${name}.metrics`,
  );
  const maxDisplacement = exactRecord(
    metrics.maxDisplacement,
    ["value", "unit", "nodeId", "vectorMm"],
    `${name}.metrics.maxDisplacement`,
  );
  const maxVonMises = exactRecord(
    metrics.maxVonMises,
    ["value", "unit", "elementId"],
    `${name}.metrics.maxVonMises`,
  );
  return {
    mesh: {
      nodes: positiveInteger(mesh.nodes, `${name}.mesh.nodes`),
      elements: positiveInteger(mesh.elements, `${name}.mesh.elements`),
      nodesPerSelection: positiveIntegerMap(
        mesh.nodesPerSelection,
        `${name}.mesh.nodesPerSelection`,
      ),
    },
    constraints: {
      fixedSelections: strings(
        constraints.fixedSelections,
        `${name}.constraints.fixedSelections`,
      ),
      loads: loads(constraints.loads, `${name}.constraints.loads`),
    },
    metrics: {
      maxDisplacement: {
        value: nonNegativeNumber(
          maxDisplacement.value,
          `${name}.metrics.maxDisplacement.value`,
        ),
        unit: literal(
          maxDisplacement.unit,
          "mm",
          `${name}.metrics.maxDisplacement.unit`,
        ),
        nodeId: positiveInteger(
          maxDisplacement.nodeId,
          `${name}.metrics.maxDisplacement.nodeId`,
        ),
        vectorMm: vector(
          maxDisplacement.vectorMm,
          `${name}.metrics.maxDisplacement.vectorMm`,
        ),
      },
      maxVonMises: {
        value: nonNegativeNumber(
          maxVonMises.value,
          `${name}.metrics.maxVonMises.value`,
        ),
        unit: literal(
          maxVonMises.unit,
          "MPa",
          `${name}.metrics.maxVonMises.unit`,
        ),
        elementId: positiveInteger(
          maxVonMises.elementId,
          `${name}.metrics.maxVonMises.elementId`,
        ),
      },
    },
  };
}

function lookupIdentity(value: unknown): RecordedLookupIdentity {
  const root = exactRecord(
    value,
    ["kind", "value"],
    "calculix_run_get.lookup",
  );
  if (root.kind === "run_id") {
    return {
      kind: "run_id",
      value: runIdValue(root.value, "calculix_run_get.lookup.value"),
    };
  }
  if (root.kind === "request_id") {
    return {
      kind: "request_id",
      value: requestIdValue(
        root.value,
        "calculix_run_get.lookup.value",
      ),
    };
  }
  throw new TypeError("calculix_run_get.lookup.kind is invalid.");
}

function assertLookupMatches(
  lookup: RecordedLookupIdentity,
  requestId: string,
  runId: string,
): void {
  if (
    (lookup.kind === "request_id" && lookup.value !== requestId) ||
    (lookup.kind === "run_id" && lookup.value !== runId)
  ) {
    throw new TypeError(
      "calculix_run_get lookup differs from its resolved run identity.",
    );
  }
}

function runIdValue(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^r-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value,
    )
  ) throw new TypeError(`${name} is not a recorded run id.`);
  return value;
}

function requestIdValue(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  ) throw new TypeError(`${name} is not a request id.`);
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null) return null;
  return nonEmptyString(value, name);
}

function loads(
  value: unknown,
  name: string,
): Array<{ selection: string; forceN: readonly [number, number, number] }> {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array.`);
  return value.map((item, index) => {
    const load = exactRecord(
      item,
      ["selection", "forceN"],
      `${name}[${index}]`,
    );
    return {
      selection: nonEmptyString(
        load.selection,
        `${name}[${index}].selection`,
      ),
      forceN: vector(load.forceN, `${name}[${index}].forceN`),
    };
  });
}

function positiveIntegerMap(
  value: unknown,
  name: string,
): Record<string, number> {
  const input = record(value, name);
  return Object.fromEntries(
    Object.entries(input).map(([key, count]) => [
      key,
      positiveInteger(count, `${name}.${key}`),
    ]),
  );
}

function vector(
  value: unknown,
  name: string,
): readonly [number, number, number] {
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

function sha256(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 digest.`);
  }
  return value;
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

function exactRecord(
  value: unknown,
  keys: readonly string[],
  name: string,
): Record<string, unknown> {
  const root = record(value, name);
  exactKeys(root, keys, name);
  return root;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${name} contains missing or unsupported fields.`);
  }
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${name} must be an object.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
