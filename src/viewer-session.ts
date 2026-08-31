/**
 * App-owned, read-only projection contract for reopening CalculiX evidence.
 *
 * The Digital Thread host transports this envelope unchanged through
 * `viewer.session.apply`.  It does not choose a solver, call a tool, or
 * translate the isolated product operation into a fleet mcp-calculix run.
 */

import serializedViewAppManifest from "./ui/app-manifest.json" with {
  type: "json",
};

export const CALCULIX_RESULTS_VIEWER_URI =
  "ui://mcp-calculix/results-viewer" as const;
export const CALCULIX_VIEW_APP_MANIFEST_URI =
  "ui://mcp-calculix/app-manifest" as const;
export const CALCULIX_VIEWER_SESSION_SCHEMA =
  "io.casys.mcp-calculix.recorded-static-proof-session/1.0" as const;
export const CALCULIX_VIEWER_SESSION_KIND = "calculix.static-proof" as const;
export const VIEWER_SESSION_APPLY_ACTION = "viewer.session.apply" as const;
export const VIEW_APP_MANIFEST_SCHEMA =
  "io.casys.mcp.view-app-manifest/1.0" as const;

export const CALCULIX_RESULT_SCHEMA_IDS = {
  ordinaryStatic: "io.casys.mcp-calculix.static-solve/2.0",
  recordedStatic: "io.casys.mcp-calculix.static-solve-recorded/2.0",
  recordedLookup: "io.casys.mcp-calculix.recorded-run-lookup/1.0",
} as const;

export interface CalculixViewAppManifest {
  readonly schemaVersion: typeof VIEW_APP_MANIFEST_SCHEMA;
  readonly app: {
    readonly id: "io.casys.mcp-calculix.results";
    readonly title: "CalculiX Static Results";
    readonly version: "0.8.4";
  };
  readonly resources: readonly [{
    readonly uri: typeof CALCULIX_RESULTS_VIEWER_URI;
    readonly ownership: "whole-view";
    readonly resultSchemas: readonly string[];
    readonly acceptedActions: readonly [typeof VIEWER_SESSION_APPLY_ACTION];
    readonly sessionSchemas: readonly [typeof CALCULIX_VIEWER_SESSION_SCHEMA];
  }];
}

/** Exact package artifact served by the provider for host-side App discovery. */
export const CALCULIX_VIEW_APP_MANIFEST: CalculixViewAppManifest =
  parseCalculixViewAppManifest(serializedViewAppManifest);

/** Canonical bytes exposed by the manifest MCP resource. */
export const CALCULIX_VIEW_APP_MANIFEST_JSON: string = `${
  JSON.stringify(CALCULIX_VIEW_APP_MANIFEST)
}\n`;

function parseCalculixViewAppManifest(
  value: unknown,
): CalculixViewAppManifest {
  const root = exactRecord(
    value,
    ["schemaVersion", "app", "resources"],
    "CalculiX View App manifest",
  );
  literal(
    root.schemaVersion,
    VIEW_APP_MANIFEST_SCHEMA,
    "CalculiX View App manifest.schemaVersion",
  );
  const app = exactRecord(
    root.app,
    ["id", "title", "version"],
    "CalculiX View App manifest.app",
  );
  literal(
    app.id,
    "io.casys.mcp-calculix.results",
    "CalculiX View App manifest.app.id",
  );
  literal(
    app.title,
    "CalculiX Static Results",
    "CalculiX View App manifest.app.title",
  );
  literal(
    app.version,
    "0.8.4",
    "CalculiX View App manifest.app.version",
  );
  const resources = denseArray(
    root.resources,
    "CalculiX View App manifest.resources",
  );
  if (resources.length !== 1) {
    throw new TypeError(
      "CalculiX View App manifest.resources must contain exactly one whole view.",
    );
  }
  const resource = exactRecord(
    resources[0],
    [
      "uri",
      "ownership",
      "resultSchemas",
      "acceptedActions",
      "sessionSchemas",
    ],
    "CalculiX View App manifest.resources[0]",
  );
  literal(
    resource.uri,
    CALCULIX_RESULTS_VIEWER_URI,
    "CalculiX View App manifest.resources[0].uri",
  );
  literal(
    resource.ownership,
    "whole-view",
    "CalculiX View App manifest.resources[0].ownership",
  );
  const expectedResultSchemas = Object.values(CALCULIX_RESULT_SCHEMA_IDS);
  const resultSchemas = denseArray(
    resource.resultSchemas,
    "CalculiX View App manifest.resources[0].resultSchemas",
  );
  if (
    resultSchemas.length !== expectedResultSchemas.length ||
    resultSchemas.some((schema, index) =>
      schema !== expectedResultSchemas[index]
    )
  ) {
    throw new TypeError(
      "CalculiX View App manifest result schemas do not match the provider contracts.",
    );
  }
  const acceptedActions = denseArray(
    resource.acceptedActions,
    "CalculiX View App manifest.resources[0].acceptedActions",
  );
  if (
    acceptedActions.length !== 1 ||
    acceptedActions[0] !== VIEWER_SESSION_APPLY_ACTION
  ) {
    throw new TypeError(
      "CalculiX View App manifest must accept viewer.session.apply exactly.",
    );
  }
  const sessionSchemas = denseArray(
    resource.sessionSchemas,
    "CalculiX View App manifest.resources[0].sessionSchemas",
  );
  if (
    sessionSchemas.length !== 1 ||
    sessionSchemas[0] !== CALCULIX_VIEWER_SESSION_SCHEMA
  ) {
    throw new TypeError(
      "CalculiX View App manifest must bind the recorded static proof session schema exactly.",
    );
  }
  return {
    schemaVersion: VIEW_APP_MANIFEST_SCHEMA,
    app: {
      id: "io.casys.mcp-calculix.results",
      title: "CalculiX Static Results",
      version: "0.8.4",
    },
    resources: [{
      uri: CALCULIX_RESULTS_VIEWER_URI,
      ownership: "whole-view",
      resultSchemas: expectedResultSchemas,
      acceptedActions: [VIEWER_SESSION_APPLY_ACTION],
      sessionSchemas: [CALCULIX_VIEWER_SESSION_SCHEMA],
    }],
  };
}

export interface CalculixRecordedArtifact {
  readonly name: RecordedArtifactName;
  readonly uri: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface CalculixRecordedRun {
  readonly schemaVersion: "2.0";
  readonly state: "completed";
  readonly runId: string;
  readonly requestId: string;
  readonly requestSha256: string;
  readonly inputArtifact: {
    readonly uri: string;
    readonly mimeType: "model/step";
    readonly sha256: string;
    readonly bytes: number;
  };
  readonly createdAt: string;
  readonly artifacts: readonly CalculixRecordedArtifact[];
}

export interface CalculixStaticObservations {
  readonly inputArtifact: {
    readonly uri: string;
    readonly mimeType: "model/step";
    readonly sha256: string;
    readonly bytes: number;
  };
  readonly mesh: {
    readonly nodes: number;
    readonly elements: number;
    readonly nodesPerSelection: Readonly<Record<string, number>>;
  };
  readonly constraints: {
    readonly fixedSelections: readonly string[];
    readonly loads: readonly {
      readonly selection: string;
      readonly forceN: readonly [number, number, number];
    }[];
  };
  readonly metrics: {
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
  };
}

export interface CalculixRecordedStaticResult
  extends CalculixStaticObservations {
  readonly schemaVersion: "2.0";
  readonly kind: "static-solve-recorded";
  readonly run: CalculixRecordedRun;
}

export interface CalculixIsolatedStaticResult {
  readonly schemaVersion: "calculix-isolated-static-result/1.0";
  readonly requestId: string;
  readonly executionIdentity: {
    readonly schemaVersion: "1.0";
    readonly profile: {
      readonly id: "calculix-static-proof-v1";
      readonly version: "1.0.0";
    };
    readonly wrapper: {
      readonly id: "calculix-static-proof-v1";
      readonly version: "1.0.0";
    };
    readonly lowering: {
      readonly id: "calculix.static.abaqus-deck";
      readonly version: "1.0";
    };
    readonly engines: {
      readonly gmsh: { readonly command: "gmsh"; readonly version: string };
      readonly ccx: { readonly command: "ccx"; readonly version: string };
    };
    readonly image: {
      readonly status: "bound-by-isolated-runner-receipt";
    };
  };
  readonly inputArtifact: {
    readonly mediaType: "model/step";
    readonly byteCount: number;
    readonly sha256: string;
  };
  readonly mesh: CalculixStaticObservations["mesh"];
  readonly constraints: CalculixStaticObservations["constraints"];
  readonly metrics: {
    readonly maximumDisplacement:
      CalculixStaticObservations["metrics"]["maxDisplacement"];
    readonly maximumVonMises:
      CalculixStaticObservations["metrics"]["maxVonMises"];
  };
}

export interface CalculixViewerSessionBasis {
  readonly projectId: string;
  readonly projectRevision: number;
  readonly subjectId: string;
  readonly thread: { readonly id: string; readonly revision: number };
  readonly sessionFingerprint: string;
}

export interface CalculixViewerSessionAnchor {
  readonly kind: string;
  readonly id: string;
  /** Opaque host anchor joined to the provider-owned result artifact identity. */
  readonly uri: string;
  readonly fingerprint: string;
}

export type CalculixViewerSessionProvenance =
  | {
    readonly kind: "mcp-calculix-recorded-run";
    readonly server: {
      readonly package: "@casys/mcp-calculix";
      readonly version: string;
    };
    readonly tool: {
      readonly name: "calculix_solve_static_recorded";
      readonly version: "1.0";
    };
    readonly runId: string;
    readonly requestId: string;
    readonly resultArtifact: {
      readonly uri: string;
      readonly fingerprint: string;
    };
  }
  | {
    readonly kind: "digital-thread-operation";
    readonly operation: "verify.run-fea-static-proof@3";
    readonly runId: string;
    readonly inputArtifact: {
      readonly uri: string;
      readonly mediaType: "model/step";
      readonly fingerprint: string;
      readonly bytes: number;
    };
    readonly resultArtifact: {
      readonly uri: string;
      readonly fingerprint: string;
    };
    readonly evidenceArtifact: {
      readonly uri: string;
      readonly fingerprint: string;
    };
  };

export type CalculixViewerSessionProjection =
  | {
    readonly status: "available";
    readonly result:
      | CalculixRecordedStaticResult
      | CalculixIsolatedStaticResult;
  }
  | { readonly status: "unresolved"; readonly reason: string }
  | { readonly status: "unavailable"; readonly reason: string };

export interface CalculixViewerSession {
  readonly schemaVersion: typeof CALCULIX_VIEWER_SESSION_SCHEMA;
  readonly kind: typeof CALCULIX_VIEWER_SESSION_KIND;
  readonly basis: CalculixViewerSessionBasis;
  readonly anchor: CalculixViewerSessionAnchor;
  readonly provenance: CalculixViewerSessionProvenance;
  readonly projection: CalculixViewerSessionProjection;
}

const RECORDED_ARTIFACTS = [
  ["input.step", "model/step", 1],
  ["request.json", "application/json", 0],
  ["mesh.geo", "text/plain", 0],
  ["mesh.inp", "text/plain", 0],
  ["gmsh.log", "text/plain", 0],
  ["job.inp", "text/plain", 0],
  ["ccx.log", "text/plain", 0],
  ["job.dat", "text/plain", 0],
  ["result.json", "application/json", 0],
] as const;

type RecordedArtifactName = typeof RECORDED_ARTIFACTS[number][0];

const RUN_ID =
  /^r-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/;
const SEMVER =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const ISO_MILLISECONDS =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

/** Validate and copy one complete recorded-run ledger block. */
export function parseCalculixRecordedRun(value: unknown): CalculixRecordedRun {
  const root = exactRecord(value, [
    "schemaVersion",
    "state",
    "runId",
    "requestId",
    "requestSha256",
    "inputArtifact",
    "createdAt",
    "artifacts",
  ], "run");
  literal(root.schemaVersion, "2.0", "run.schemaVersion");
  literal(root.state, "completed", "run.state");
  const runId = pattern(root.runId, RUN_ID, "run.runId");
  const inputArtifact = recordedInputArtifact(
    root.inputArtifact,
    runId,
    "run.inputArtifact",
  );
  const artifactValues = denseArray(root.artifacts, "run.artifacts");
  if (artifactValues.length !== 9) {
    throw new TypeError(
      "run.artifacts must contain the exact nine recorded artifacts.",
    );
  }
  const artifacts = artifactValues.map((artifact, index) => {
    const [name, mimeType, minimumBytes] = RECORDED_ARTIFACTS[index]!;
    const item = exactRecord(
      artifact,
      ["name", "uri", "mimeType", "bytes", "sha256"],
      `run.artifacts[${index}]`,
    );
    literal(item.name, name, `run.artifacts[${index}].name`);
    literal(item.mimeType, mimeType, `run.artifacts[${index}].mimeType`);
    const uri = literal(
      item.uri,
      recordedArtifactUri(runId, name),
      `run.artifacts[${index}].uri`,
    );
    return {
      name,
      uri,
      mimeType,
      bytes: integerAtLeast(
        item.bytes,
        minimumBytes,
        `run.artifacts[${index}].bytes`,
      ),
      sha256: digest(item.sha256, `run.artifacts[${index}].sha256`),
    };
  });
  const step = artifacts[0]!;
  const request = artifacts[1]!;
  if (
    step.uri !== inputArtifact.uri ||
    step.mimeType !== inputArtifact.mimeType ||
    step.sha256 !== inputArtifact.sha256 ||
    step.bytes !== inputArtifact.bytes
  ) {
    throw new TypeError(
      "run.inputArtifact must equal the recorded input.step artifact.",
    );
  }
  const requestSha256 = digest(root.requestSha256, "run.requestSha256");
  if (request.sha256 !== requestSha256) {
    throw new TypeError(
      "run.requestSha256 must equal the recorded request.json artifact.",
    );
  }
  return {
    schemaVersion: "2.0",
    state: "completed",
    runId,
    requestId: pattern(root.requestId, REQUEST_ID, "run.requestId"),
    requestSha256,
    inputArtifact,
    createdAt: canonicalTimestamp(root.createdAt, "run.createdAt"),
    artifacts,
  };
}

/** Parse the normalized result.json body before its ledger is attached. */
export function parseCalculixRecordedResultDocument(
  value: unknown,
): Omit<CalculixRecordedStaticResult, "run"> {
  const root = exactRecord(value, [
    "schemaVersion",
    "kind",
    "inputArtifact",
    "mesh",
    "constraints",
    "metrics",
  ], "recorded result");
  literal(root.schemaVersion, "2.0", "recorded result.schemaVersion");
  literal(root.kind, "static-solve-recorded", "recorded result.kind");
  const uri = pattern(
    exactRecord(
      root.inputArtifact,
      ["uri", "mimeType", "sha256", "bytes"],
      "recorded result.inputArtifact",
    ).uri,
    /^casys:\/\/calculix\/runs\/r-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/input\.step$/,
    "recorded result.inputArtifact.uri",
  );
  const runId = uri.slice(
    "casys://calculix/runs/".length,
    -"/input.step".length,
  );
  return {
    schemaVersion: "2.0",
    kind: "static-solve-recorded",
    inputArtifact: recordedInputArtifact(
      root.inputArtifact,
      runId,
      "recorded result.inputArtifact",
    ),
    ...staticObservations(root, "recorded result"),
  };
}

/** Parse the direct recorded-solve result including its complete run ledger. */
export function parseCalculixRecordedStaticResult(
  value: unknown,
): CalculixRecordedStaticResult {
  const root = exactRecord(value, [
    "schemaVersion",
    "kind",
    "inputArtifact",
    "mesh",
    "constraints",
    "metrics",
    "run",
  ], "recorded solve");
  const document = parseCalculixRecordedResultDocument({
    schemaVersion: root.schemaVersion,
    kind: root.kind,
    inputArtifact: root.inputArtifact,
    mesh: root.mesh,
    constraints: root.constraints,
    metrics: root.metrics,
  });
  const run = parseCalculixRecordedRun(root.run);
  assertRecordedResultMatchesRun(document, run);
  return { ...document, run };
}

/** Validate the exact result.json contract owned by the isolated @3 operation. */
export function parseCalculixIsolatedStaticResult(
  value: unknown,
): CalculixIsolatedStaticResult {
  const root = exactRecord(value, [
    "schemaVersion",
    "requestId",
    "executionIdentity",
    "inputArtifact",
    "mesh",
    "constraints",
    "metrics",
  ], "isolated result");
  literal(
    root.schemaVersion,
    "calculix-isolated-static-result/1.0",
    "isolated result.schemaVersion",
  );
  const executionIdentity = isolatedExecutionIdentity(root.executionIdentity);
  const input = exactRecord(
    root.inputArtifact,
    ["mediaType", "byteCount", "sha256"],
    "isolated result.inputArtifact",
  );
  literal(
    input.mediaType,
    "model/step",
    "isolated result.inputArtifact.mediaType",
  );
  const observations = staticObservations(root, "isolated result", true);
  const displacement = observations.metrics.maxDisplacement;
  const magnitude = Math.hypot(...displacement.vectorMm);
  if (
    Math.abs(displacement.value - magnitude) >
      8 * Number.EPSILON * Math.max(1, displacement.value, magnitude)
  ) {
    throw new TypeError(
      "isolated result maximum displacement disagrees with its vector.",
    );
  }
  return {
    schemaVersion: "calculix-isolated-static-result/1.0",
    requestId: pattern(root.requestId, REQUEST_ID, "isolated result.requestId"),
    executionIdentity,
    inputArtifact: {
      mediaType: "model/step",
      byteCount: positiveInteger(
        input.byteCount,
        "isolated result.inputArtifact.byteCount",
      ),
      sha256: digest(
        input.sha256,
        "isolated result.inputArtifact.sha256",
      ),
    },
    mesh: observations.mesh,
    constraints: observations.constraints,
    metrics: {
      maximumDisplacement: observations.metrics.maxDisplacement,
      maximumVonMises: observations.metrics.maxVonMises,
    },
  };
}

/**
 * Strictly validate one opaque session delivered through viewer.session.apply,
 * including the App-owned fingerprint of the complete recorded session.
 */
export async function parseCalculixViewerSession(
  value: unknown,
): Promise<CalculixViewerSession> {
  const session = parseCalculixViewerSessionStructure(value);
  const actualFingerprint = await calculixRecordedSessionFingerprint(value);
  if (session.basis.sessionFingerprint !== actualFingerprint) {
    throw new TypeError(
      "viewer session.basis.sessionFingerprint does not match the recorded session.",
    );
  }
  await assertCalculixViewerSessionJoins(session);
  return session;
}

function parseCalculixViewerSessionStructure(
  value: unknown,
): CalculixViewerSession {
  const root = exactRecord(value, [
    "schemaVersion",
    "kind",
    "basis",
    "anchor",
    "provenance",
    "projection",
  ], "viewer session");
  literal(
    root.schemaVersion,
    CALCULIX_VIEWER_SESSION_SCHEMA,
    "viewer session.schemaVersion",
  );
  literal(
    root.kind,
    CALCULIX_VIEWER_SESSION_KIND,
    "viewer session.kind",
  );
  const basisValue = exactRecord(root.basis, [
    "projectId",
    "projectRevision",
    "subjectId",
    "thread",
    "sessionFingerprint",
  ], "viewer session.basis");
  const thread = exactRecord(
    basisValue.thread,
    ["id", "revision"],
    "viewer session.basis.thread",
  );
  const basis: CalculixViewerSessionBasis = {
    projectId: nonEmpty(basisValue.projectId, "viewer session.basis.projectId"),
    projectRevision: nonNegativeInteger(
      basisValue.projectRevision,
      "viewer session.basis.projectRevision",
    ),
    subjectId: nonEmpty(basisValue.subjectId, "viewer session.basis.subjectId"),
    thread: {
      id: nonEmpty(thread.id, "viewer session.basis.thread.id"),
      revision: nonNegativeInteger(
        thread.revision,
        "viewer session.basis.thread.revision",
      ),
    },
    sessionFingerprint: fingerprint(
      basisValue.sessionFingerprint,
      "viewer session.basis.sessionFingerprint",
    ),
  };
  const anchorValue = exactRecord(
    root.anchor,
    ["kind", "id", "uri", "fingerprint"],
    "viewer session.anchor",
  );
  const anchor = {
    kind: nonEmpty(anchorValue.kind, "viewer session.anchor.kind"),
    id: nonEmpty(anchorValue.id, "viewer session.anchor.id"),
    uri: nonEmpty(anchorValue.uri, "viewer session.anchor.uri"),
    fingerprint: fingerprint(
      anchorValue.fingerprint,
      "viewer session.anchor.fingerprint",
    ),
  };
  const provenance = viewerProvenance(root.provenance);
  const projectionValue = record(root.projection, "viewer session.projection");
  let projection: CalculixViewerSessionProjection;
  if (projectionValue.status === "available") {
    exactKeys(
      projectionValue,
      ["status", "result"],
      "viewer session.projection",
    );
    if (provenance.kind === "mcp-calculix-recorded-run") {
      projection = {
        status: "available",
        result: parseCalculixRecordedStaticResult(projectionValue.result),
      };
    } else {
      const result = parseCalculixIsolatedStaticResult(projectionValue.result);
      if (
        provenance.inputArtifact.fingerprint !==
          `sha256:${result.inputArtifact.sha256}` ||
        provenance.inputArtifact.bytes !== result.inputArtifact.byteCount
      ) {
        throw new TypeError(
          "viewer session proof input does not match the isolated result.",
        );
      }
      projection = { status: "available", result };
    }
  } else if (
    projectionValue.status === "unresolved" ||
    projectionValue.status === "unavailable"
  ) {
    exactKeys(
      projectionValue,
      ["status", "reason"],
      "viewer session.projection",
    );
    projection = {
      status: projectionValue.status,
      reason: nonEmpty(
        projectionValue.reason,
        "viewer session.projection.reason",
      ),
    };
  } else {
    throw new TypeError(
      "viewer session.projection.status must be available, unresolved, or unavailable.",
    );
  }
  return {
    schemaVersion: CALCULIX_VIEWER_SESSION_SCHEMA,
    kind: CALCULIX_VIEWER_SESSION_KIND,
    basis,
    anchor,
    provenance,
    projection,
  };
}

/**
 * SHA-256 of the complete recorded session identity and projection.
 *
 * The canonical subdocument is exactly
 * `{schemaVersion, kind, basis, anchor, provenance, projection}` where basis
 * contains `{projectId, projectRevision, subjectId, thread}`. Only
 * `basis.sessionFingerprint` is omitted to avoid self-reference. Object keys
 * are recursively sorted; arrays must be dense and unadorned; every number
 * must be finite JSON.
 */
export async function calculixRecordedSessionFingerprint(
  value: unknown,
): Promise<string> {
  const root = exactRecord(value, [
    "schemaVersion",
    "kind",
    "basis",
    "anchor",
    "provenance",
    "projection",
  ], "viewer session fingerprint input");
  const basis = exactRecord(root.basis, [
    "projectId",
    "projectRevision",
    "subjectId",
    "thread",
    "sessionFingerprint",
  ], "viewer session fingerprint input.basis");
  const fingerprintDocument = {
    schemaVersion: root.schemaVersion,
    kind: root.kind,
    basis: {
      projectId: basis.projectId,
      projectRevision: basis.projectRevision,
      subjectId: basis.subjectId,
      thread: basis.thread,
    },
    anchor: root.anchor,
    provenance: root.provenance,
    projection: root.projection,
  };
  const bytes = new TextEncoder().encode(
    canonicalRecordedSessionJson(
      fingerprintDocument,
      "viewer session fingerprint document",
    ),
  );
  const digestBytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes),
  );
  const digestHex = Array.from(
    digestBytes,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return `sha256:${digestHex}`;
}

export function assertRecordedResultMatchesRun(
  result: Omit<CalculixRecordedStaticResult, "run">,
  run: CalculixRecordedRun,
): void {
  if (
    result.inputArtifact.uri !== run.inputArtifact.uri ||
    result.inputArtifact.mimeType !== run.inputArtifact.mimeType ||
    result.inputArtifact.sha256 !== run.inputArtifact.sha256 ||
    result.inputArtifact.bytes !== run.inputArtifact.bytes
  ) {
    throw new TypeError(
      "recorded result inputArtifact does not match its complete run ledger.",
    );
  }
}

/** SHA-256 identity of the exact canonical isolated result document bytes. */
export async function calculixIsolatedStaticResultFingerprint(
  value: unknown,
): Promise<string> {
  return await canonicalJsonFingerprint(
    parseCalculixIsolatedStaticResult(value),
    false,
    "isolated result artifact",
  );
}

/** SHA-256 identity of provider-recorded canonical `result.json` bytes. */
export async function calculixRecordedResultDocumentFingerprint(
  value: unknown,
): Promise<string> {
  return await canonicalJsonFingerprint(
    parseCalculixRecordedResultDocument(value),
    true,
    "recorded result.json artifact",
  );
}

async function assertCalculixViewerSessionJoins(
  session: CalculixViewerSession,
): Promise<void> {
  const resultArtifact = session.provenance.resultArtifact;
  if (
    session.anchor.uri !== resultArtifact.uri ||
    session.anchor.fingerprint !== resultArtifact.fingerprint
  ) {
    throw new TypeError(
      "viewer session.anchor must identify the exact provider result artifact.",
    );
  }

  if (session.provenance.kind === "digital-thread-operation") {
    assertDigestAddress(
      session.provenance.inputArtifact.uri,
      session.provenance.inputArtifact.fingerprint,
      /^casys:\/\/isolated-output\/sha256\/([a-f0-9]{64})$/,
      "viewer session.provenance.inputArtifact",
    );
    assertDigestAddress(
      resultArtifact.uri,
      resultArtifact.fingerprint,
      /^casys:\/\/isolated-output\/sha256\/([a-f0-9]{64})$/,
      "viewer session.provenance.resultArtifact",
    );
    assertDigestAddress(
      session.provenance.evidenceArtifact.uri,
      session.provenance.evidenceArtifact.fingerprint,
      /^casys:\/\/calculix-isolated-execution-evidence\/sha256\/([a-f0-9]{64})$/,
      "viewer session.provenance.evidenceArtifact",
    );
    if (session.projection.status !== "available") return;
    const result = session.projection.result;
    if (result.schemaVersion !== "calculix-isolated-static-result/1.0") {
      throw new TypeError(
        "viewer session Digital Thread provenance requires an isolated result.",
      );
    }
    const resultFingerprint = await canonicalJsonFingerprint(
      result,
      false,
      "viewer session isolated result artifact",
    );
    if (resultFingerprint !== resultArtifact.fingerprint) {
      throw new TypeError(
        "viewer session isolated result does not match its result artifact fingerprint.",
      );
    }
    return;
  }

  const expectedResultUri = recordedArtifactUri(
    session.provenance.runId,
    "result.json",
  );
  if (resultArtifact.uri !== expectedResultUri) {
    throw new TypeError(
      "viewer session recorded result artifact does not match its run identity.",
    );
  }
  if (session.projection.status !== "available") return;
  const result = session.projection.result;
  if (result.schemaVersion !== "2.0") {
    throw new TypeError(
      "viewer session recorded-run provenance requires a recorded static result.",
    );
  }
  if (
    result.run.runId !== session.provenance.runId ||
    result.run.requestId !== session.provenance.requestId
  ) {
    throw new TypeError(
      "viewer session recorded result does not match its provenance run and request identities.",
    );
  }
  const ledgerArtifact = result.run.artifacts.find((artifact) =>
    artifact.name === "result.json"
  );
  if (
    !ledgerArtifact ||
    ledgerArtifact.uri !== resultArtifact.uri ||
    `sha256:${ledgerArtifact.sha256}` !== resultArtifact.fingerprint
  ) {
    throw new TypeError(
      "viewer session recorded result artifact does not match its run ledger.",
    );
  }
  const document = {
    schemaVersion: result.schemaVersion,
    kind: result.kind,
    inputArtifact: result.inputArtifact,
    mesh: result.mesh,
    constraints: result.constraints,
    metrics: result.metrics,
  };
  const documentFingerprint = await canonicalJsonFingerprint(
    document,
    true,
    "viewer session recorded result.json artifact",
  );
  if (documentFingerprint !== resultArtifact.fingerprint) {
    throw new TypeError(
      "viewer session recorded result does not match its result.json fingerprint.",
    );
  }
}

function assertDigestAddress(
  uri: string,
  artifactFingerprint: string,
  pattern: RegExp,
  name: string,
): void {
  const match = pattern.exec(uri);
  if (!match || artifactFingerprint !== `sha256:${match[1]}`) {
    throw new TypeError(
      `${name} URI and fingerprint must identify the same bytes.`,
    );
  }
}

async function canonicalJsonFingerprint(
  value: unknown,
  trailingNewline: boolean,
  name: string,
): Promise<string> {
  const json = canonicalRecordedSessionJson(value, name) +
    (trailingNewline ? "\n" : "");
  const bytes = new TextEncoder().encode(json);
  const digestBytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes),
  );
  return `sha256:${
    Array.from(
      digestBytes,
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("")
  }`;
}

function viewerProvenance(value: unknown): CalculixViewerSessionProvenance {
  const root = record(value, "viewer session.provenance");
  if (root.kind === "mcp-calculix-recorded-run") {
    exactKeys(
      root,
      [
        "kind",
        "server",
        "tool",
        "runId",
        "requestId",
        "resultArtifact",
      ],
      "viewer session.provenance",
    );
    const server = exactRecord(
      root.server,
      ["package", "version"],
      "viewer session.provenance.server",
    );
    literal(
      server.package,
      "@casys/mcp-calculix",
      "viewer session.provenance.server.package",
    );
    const tool = exactRecord(
      root.tool,
      ["name", "version"],
      "viewer session.provenance.tool",
    );
    literal(
      tool.name,
      "calculix_solve_static_recorded",
      "viewer session.provenance.tool.name",
    );
    literal(
      tool.version,
      "1.0",
      "viewer session.provenance.tool.version",
    );
    return {
      kind: "mcp-calculix-recorded-run",
      server: {
        package: "@casys/mcp-calculix",
        version: pattern(
          server.version,
          SEMVER,
          "viewer session.provenance.server.version",
        ),
      },
      tool: { name: "calculix_solve_static_recorded", version: "1.0" },
      runId: pattern(root.runId, RUN_ID, "viewer session.provenance.runId"),
      requestId: pattern(
        root.requestId,
        REQUEST_ID,
        "viewer session.provenance.requestId",
      ),
      resultArtifact: evidenceArtifact(
        root.resultArtifact,
        "viewer session.provenance.resultArtifact",
      ),
    };
  }
  if (root.kind !== "digital-thread-operation") {
    throw new TypeError(
      "viewer session.provenance.kind is not supported by CalculiX.",
    );
  }
  exactKeys(root, [
    "kind",
    "operation",
    "runId",
    "inputArtifact",
    "resultArtifact",
    "evidenceArtifact",
  ], "viewer session.provenance");
  literal(
    root.operation,
    "verify.run-fea-static-proof@3",
    "viewer session.provenance.operation",
  );
  const input = exactRecord(root.inputArtifact, [
    "uri",
    "mediaType",
    "fingerprint",
    "bytes",
  ], "viewer session.provenance.inputArtifact");
  literal(
    input.mediaType,
    "model/step",
    "viewer session.provenance.inputArtifact.mediaType",
  );
  return {
    kind: "digital-thread-operation",
    operation: "verify.run-fea-static-proof@3",
    runId: nonEmpty(root.runId, "viewer session.provenance.runId"),
    inputArtifact: {
      uri: nonEmpty(input.uri, "viewer session.provenance.inputArtifact.uri"),
      mediaType: "model/step",
      fingerprint: fingerprint(
        input.fingerprint,
        "viewer session.provenance.inputArtifact.fingerprint",
      ),
      bytes: positiveInteger(
        input.bytes,
        "viewer session.provenance.inputArtifact.bytes",
      ),
    },
    resultArtifact: evidenceArtifact(
      root.resultArtifact,
      "viewer session.provenance.resultArtifact",
    ),
    evidenceArtifact: evidenceArtifact(
      root.evidenceArtifact,
      "viewer session.provenance.evidenceArtifact",
    ),
  };
}

function evidenceArtifact(
  value: unknown,
  name: string,
): { uri: string; fingerprint: string } {
  const root = exactRecord(value, ["uri", "fingerprint"], name);
  return {
    uri: nonEmpty(root.uri, `${name}.uri`),
    fingerprint: fingerprint(root.fingerprint, `${name}.fingerprint`),
  };
}

function isolatedExecutionIdentity(
  value: unknown,
): CalculixIsolatedStaticResult["executionIdentity"] {
  const root = exactRecord(value, [
    "schemaVersion",
    "profile",
    "wrapper",
    "lowering",
    "engines",
    "image",
  ], "isolated result.executionIdentity");
  literal(
    root.schemaVersion,
    "1.0",
    "isolated result.executionIdentity.schemaVersion",
  );
  const profile = fixedIdentity(
    root.profile,
    "calculix-static-proof-v1",
    "1.0.0",
    "isolated result.executionIdentity.profile",
  );
  const wrapper = fixedIdentity(
    root.wrapper,
    "calculix-static-proof-v1",
    "1.0.0",
    "isolated result.executionIdentity.wrapper",
  );
  const lowering = fixedIdentity(
    root.lowering,
    "calculix.static.abaqus-deck",
    "1.0",
    "isolated result.executionIdentity.lowering",
  );
  const engines = exactRecord(
    root.engines,
    ["gmsh", "ccx"],
    "isolated result.executionIdentity.engines",
  );
  const image = exactRecord(
    root.image,
    ["status"],
    "isolated result.executionIdentity.image",
  );
  literal(
    image.status,
    "bound-by-isolated-runner-receipt",
    "isolated result.executionIdentity.image.status",
  );
  return {
    schemaVersion: "1.0",
    profile,
    wrapper,
    lowering,
    engines: {
      gmsh: engine(engines.gmsh, "gmsh"),
      ccx: engine(engines.ccx, "ccx"),
    },
    image: { status: "bound-by-isolated-runner-receipt" },
  };
}

function fixedIdentity<I extends string, V extends string>(
  value: unknown,
  id: I,
  version: V,
  name: string,
): { id: I; version: V } {
  const root = exactRecord(value, ["id", "version"], name);
  return {
    id: literal(root.id, id, `${name}.id`),
    version: literal(root.version, version, `${name}.version`),
  };
}

function engine<C extends "gmsh" | "ccx">(
  value: unknown,
  command: C,
): { command: C; version: string } {
  const root = exactRecord(
    value,
    ["command", "version"],
    `isolated result.executionIdentity.engines.${command}`,
  );
  return {
    command: literal(
      root.command,
      command,
      `isolated result.executionIdentity.engines.${command}.command`,
    ),
    version: nonEmpty(
      root.version,
      `isolated result.executionIdentity.engines.${command}.version`,
    ),
  };
}

function staticObservations(
  root: Record<string, unknown>,
  name: string,
  isolated = false,
): Omit<CalculixStaticObservations, "inputArtifact"> {
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
    isolated
      ? ["maximumDisplacement", "maximumVonMises"]
      : ["maxDisplacement", "maxVonMises"],
    `${name}.metrics`,
  );
  const maxDisplacement = exactRecord(
    metrics[isolated ? "maximumDisplacement" : "maxDisplacement"],
    ["value", "unit", "nodeId", "vectorMm"],
    `${name}.metrics.maximumDisplacement`,
  );
  const maxVonMises = exactRecord(
    metrics[isolated ? "maximumVonMises" : "maxVonMises"],
    ["value", "unit", "elementId"],
    `${name}.metrics.maximumVonMises`,
  );
  const nodesPerSelection = positiveIntegerMap(
    mesh.nodesPerSelection,
    `${name}.mesh.nodesPerSelection`,
  );
  const fixedSelections = strings(
    constraints.fixedSelections,
    `${name}.constraints.fixedSelections`,
  );
  const parsedLoads = loads(constraints.loads, `${name}.constraints.loads`);
  for (
    const selection of [
      ...fixedSelections,
      ...parsedLoads.map((load) => load.selection),
    ]
  ) {
    if (!Object.hasOwn(nodesPerSelection, selection)) {
      throw new TypeError(
        `${name} constraint ${selection} has no positive mesh count.`,
      );
    }
  }
  return {
    mesh: {
      nodes: positiveInteger(mesh.nodes, `${name}.mesh.nodes`),
      elements: positiveInteger(mesh.elements, `${name}.mesh.elements`),
      nodesPerSelection,
    },
    constraints: { fixedSelections, loads: parsedLoads },
    metrics: {
      maxDisplacement: {
        value: nonNegativeNumber(
          maxDisplacement.value,
          `${name}.metrics.maximumDisplacement.value`,
        ),
        unit: literal(
          maxDisplacement.unit,
          "mm",
          `${name}.metrics.maximumDisplacement.unit`,
        ),
        nodeId: positiveInteger(
          maxDisplacement.nodeId,
          `${name}.metrics.maximumDisplacement.nodeId`,
        ),
        vectorMm: vector(
          maxDisplacement.vectorMm,
          `${name}.metrics.maximumDisplacement.vectorMm`,
        ),
      },
      maxVonMises: {
        value: nonNegativeNumber(
          maxVonMises.value,
          `${name}.metrics.maximumVonMises.value`,
        ),
        unit: literal(
          maxVonMises.unit,
          "MPa",
          `${name}.metrics.maximumVonMises.unit`,
        ),
        elementId: positiveInteger(
          maxVonMises.elementId,
          `${name}.metrics.maximumVonMises.elementId`,
        ),
      },
    },
  };
}

function recordedInputArtifact(
  value: unknown,
  runId: string,
  name: string,
): CalculixStaticObservations["inputArtifact"] {
  const root = exactRecord(
    value,
    ["uri", "mimeType", "sha256", "bytes"],
    name,
  );
  return {
    uri: literal(
      root.uri,
      recordedArtifactUri(runId, "input.step"),
      `${name}.uri`,
    ),
    mimeType: literal(root.mimeType, "model/step", `${name}.mimeType`),
    sha256: digest(root.sha256, `${name}.sha256`),
    bytes: positiveInteger(root.bytes, `${name}.bytes`),
  };
}

function recordedArtifactUri(
  runId: string,
  name: RecordedArtifactName,
): string {
  return `casys://calculix/runs/${runId}/${name}`;
}

function positiveIntegerMap(
  value: unknown,
  name: string,
): Record<string, number> {
  const root = record(value, name);
  const output: Record<string, number> = {};
  for (const [key, count] of Object.entries(root)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(key)) {
      throw new TypeError(`${name} contains an invalid selection name.`);
    }
    output[key] = positiveInteger(count, `${name}.${key}`);
  }
  return output;
}

function loads(
  value: unknown,
  name: string,
): Array<{ selection: string; forceN: [number, number, number] }> {
  return denseArray(value, name).map((item, index) => {
    const root = exactRecord(
      item,
      ["selection", "forceN"],
      `${name}[${index}]`,
    );
    return {
      selection: nonEmpty(root.selection, `${name}[${index}].selection`),
      forceN: vector(root.forceN, `${name}[${index}].forceN`),
    };
  });
}

function strings(value: unknown, name: string): string[] {
  return denseArray(value, name).map((item, index) =>
    nonEmpty(item, `${name}[${index}]`)
  );
}

function vector(value: unknown, name: string): [number, number, number] {
  const values = denseArray(value, name);
  if (values.length !== 3) {
    throw new TypeError(`${name} must contain three values.`);
  }
  return [
    finiteNumber(values[0], `${name}[0]`),
    finiteNumber(values[1], `${name}[1]`),
    finiteNumber(values[2], `${name}[2]`),
  ];
}

function denseArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array.`);
  const allowed = new Set<string>(["length"]);
  for (let index = 0; index < value.length; index += 1) {
    allowed.add(String(index));
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== allowed.size ||
    ownKeys.some((key) => typeof key !== "string" || !allowed.has(key))
  ) {
    throw new TypeError(`${name} must be a dense, unadorned array.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${name} must be a dense, unadorned array.`);
    }
  }
  return value;
}

function canonicalRecordedSessionJson(value: unknown, name: string): string {
  if (
    value === null || typeof value === "boolean" || typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${name} must contain only finite JSON numbers.`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = denseArray(value, name);
    return `[${
      items.map((item, index) =>
        canonicalRecordedSessionJson(item, `${name}[${index}]`)
      ).join(",")
    }]`;
  }
  const root = record(value, name);
  const prototype = Object.getPrototypeOf(root);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must contain only plain JSON objects.`);
  }
  const ownKeys = Reflect.ownKeys(root);
  if (ownKeys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${name} must contain only string-keyed JSON objects.`);
  }
  const keys = (ownKeys as string[]).toSorted();
  const fields = keys.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(root, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${name}.${key} must be an enumerable JSON value.`);
    }
    return `${JSON.stringify(key)}:${
      canonicalRecordedSessionJson(descriptor.value, `${name}.${key}`)
    }`;
  });
  return `{${fields.join(",")}}`;
}

function literal<T extends string>(
  value: unknown,
  expected: T,
  name: string,
): T {
  if (value !== expected) throw new TypeError(`${name} must be ${expected}.`);
  return expected;
}

function digest(value: unknown, name: string): string {
  return pattern(value, DIGEST, name);
}

function fingerprint(value: unknown, name: string): string {
  return pattern(value, FINGERPRINT, name);
}

function pattern(value: unknown, expected: RegExp, name: string): string {
  if (typeof value !== "string" || !expected.test(value)) {
    throw new TypeError(`${name} has an invalid format.`);
  }
  return value;
}

function canonicalTimestamp(value: unknown, name: string): string {
  const timestamp = pattern(value, ISO_MILLISECONDS, name);
  try {
    if (new Date(timestamp).toISOString() !== timestamp) {
      throw new TypeError(`${name} is not canonical UTC.`);
    }
  } catch {
    throw new TypeError(`${name} is not canonical UTC.`);
  }
  return timestamp;
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  return integerAtLeast(value, 1, name);
}

function nonNegativeInteger(value: unknown, name: string): number {
  return integerAtLeast(value, 0, name);
}

function integerAtLeast(value: unknown, minimum: number, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new TypeError(`${name} must be an integer at least ${minimum}.`);
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

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
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
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${name} contains missing or unsupported fields.`);
  }
  for (const key of ownKeys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${name} contains missing or unsupported fields.`);
    }
  }
  const actual = (ownKeys as string[]).toSorted();
  const expected = [...keys].toSorted();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${name} contains missing or unsupported fields.`);
  }
}
