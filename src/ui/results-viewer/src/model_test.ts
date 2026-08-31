import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  advertisedComponentCatalog,
  CASYS_SURFACE_CONTEXT_KEY,
  mountComponentSurface,
} from "@casys/mcp-view-components";
import type { PreactSurfaceContext } from "@casys/mcp-view-components/preact";
import {
  CALCULIX_RESULT_SCHEMA_IDS,
  CALCULIX_VIEW_APP_MANIFEST,
  CALCULIX_VIEWER_SESSION_SCHEMA,
  calculixIsolatedStaticResultFingerprint,
  calculixRecordedSessionFingerprint,
  VIEWER_SESSION_APPLY_ACTION,
} from "../../../viewer-session.ts";
import {
  CALCULIX_COMPONENT_KEYS,
  CALCULIX_COMPONENT_REGISTRY,
  CALCULIX_RESULTS_SURFACE,
} from "./components.tsx";
import {
  CALCULIX_APP_INFO,
  renderDisplayState,
  resolveCalculixSurface,
} from "./app.ts";
import {
  displayStateFromToolResult,
  displayStateFromViewerSession,
  hydrateRecordedRunLookup,
  parseRecordedRunLookup,
  parseStaticSolve,
  type StaticResultsViewData,
  type StaticSolveResult,
  toolErrorMessage,
} from "./model.ts";
import { createBufferedSessionReceiver } from "./session-receiver.ts";

const RUN_ID = "r-00000000-0000-4000-8000-000000000000";
const RUN_URI = `casys://calculix/runs/${RUN_ID}`;
const STEP_SHA256 = "b".repeat(64);

const result: StaticSolveResult = {
  schemaVersion: "2.0",
  kind: "static-solve",
  inputArtifact: {
    path: "/tmp/calculix-input-example/input.step",
    sourcePath: "/exports/bracket.step",
    sha256: "a".repeat(64),
    bytes: 4256,
  },
  mesh: {
    nodes: 9669,
    elements: 5568,
    nodesPerSelection: { FIXED: 210, LOADED: 87 },
  },
  constraints: {
    fixedSelections: ["FIXED"],
    loads: [{ selection: "LOADED", forceN: [0, 0, -500] }],
  },
  metrics: {
    maxDisplacement: {
      value: 0.0428,
      unit: "mm",
      nodeId: 26,
      vectorMm: [0.01, 0.02, -0.03],
    },
    maxVonMises: { value: 26.6, unit: "MPa", elementId: 5229 },
  },
};

const recordedDocument = {
  schemaVersion: "2.0",
  kind: "static-solve-recorded",
  inputArtifact: {
    uri: `${RUN_URI}/input.step`,
    mimeType: "model/step",
    sha256: STEP_SHA256,
    bytes: 4256,
  },
  mesh: result.mesh,
  constraints: result.constraints,
  metrics: result.metrics,
} as const;

const componentContext = {} as unknown as PreactSurfaceContext<
  StaticResultsViewData
>;

Deno.test("results viewer parses the closed direct static-solve v2 result", () => {
  assertEquals(parseStaticSolve(result), result);
  assertThrows(
    () => parseStaticSolve({ ...result, extra: true }),
    TypeError,
    "unsupported fields",
  );
  assertThrows(
    () => parseStaticSolve({ ...result, kind: "run" }),
    TypeError,
    "static-solve",
  );
});

Deno.test("recorded lookup validates the whole ledger and request fingerprint", async () => {
  const fixture = await recordedFixture();
  assertEquals(parseRecordedRunLookup(fixture.lookup), fixture.lookup);

  const wrongArtifact = structuredClone(fixture.lookup);
  wrongArtifact.run.artifacts[4]!.uri = `${RUN_URI}/different.log`;
  assertThrows(
    () => parseRecordedRunLookup(wrongArtifact),
    TypeError,
    "artifacts[4].uri",
  );

  const wrongRequestFingerprint = structuredClone(fixture.lookup);
  (wrongRequestFingerprint.run as { requestSha256: string }).requestSha256 = "f"
    .repeat(64);
  assertThrows(
    () => parseRecordedRunLookup(wrongRequestFingerprint),
    TypeError,
    "requestSha256",
  );

  const extraNested = structuredClone(fixture.lookup);
  Object.assign(extraNested.run.inputArtifact, {
    sourcePath: "/tmp/input.step",
  });
  assertThrows(
    () => parseRecordedRunLookup(extraNested),
    TypeError,
    "unsupported fields",
  );

  const impossibleTimestamp = structuredClone(fixture.lookup);
  (impossibleTimestamp.run as { createdAt: string }).createdAt =
    "2026-99-31T09:15:00.000Z";
  assertThrows(
    () => parseRecordedRunLookup(impossibleTimestamp),
    TypeError,
    "canonical UTC",
  );

  const mismatchedLookup = structuredClone(fixture.lookup);
  (mismatchedLookup.lookup as { value: string }).value =
    "r-11111111-1111-4111-8111-111111111111";
  assertThrows(
    () => parseRecordedRunLookup(mismatchedLookup),
    TypeError,
    "lookup differs",
  );
});

Deno.test("completed run_get reopens and hashes exact result.json without solving", async () => {
  const fixture = await recordedFixture();
  const reads: string[] = [];
  const state = await hydrateRecordedRunLookup(fixture.lookup, (uri) => {
    reads.push(uri);
    return Promise.resolve(fixture.resource);
  });
  assertEquals(reads, [`${RUN_URI}/result.json`]);
  assertEquals(state.kind, "result");
  if (state.kind !== "result") throw new Error("expected result state");
  assertEquals(state.result.kind, "static-solve-recorded");
  if (state.result.kind !== "static-solve-recorded") {
    throw new Error("expected recorded result");
  }
  assertEquals(state.result.run, fixture.lookup.run);

  await assertRejects(
    () =>
      hydrateRecordedRunLookup(fixture.lookup, () =>
        Promise.resolve({
          contents: [{
            ...fixture.resource.contents[0],
            text: `${fixture.resultText} `,
          }],
        })),
    TypeError,
    "byte count changed",
  );
});

Deno.test("non-terminal run_get states stay literal and never read a resource", async () => {
  let reads = 0;
  const read = () => {
    reads += 1;
    return Promise.reject(new Error("must not read"));
  };
  assertEquals(
    await hydrateRecordedRunLookup({
      schemaVersion: "1.0",
      status: "dispatched",
      lookup: { kind: "request_id", value: "request-1" },
      requestId: "request-1",
      runId: RUN_ID,
      reason: null,
    }, read),
    { kind: "unresolved", status: "dispatched", reason: null },
  );
  assertEquals(
    await hydrateRecordedRunLookup({
      schemaVersion: "1.0",
      status: "outcome_unknown",
      lookup: { kind: "request_id", value: "request-1" },
      requestId: "request-1",
      reason: "dispatch acknowledgement has no terminal receipt",
    }, read),
    {
      kind: "unresolved",
      status: "outcome_unknown",
      reason: "dispatch acknowledgement has no terminal receipt",
    },
  );
  assertEquals(
    await hydrateRecordedRunLookup({
      schemaVersion: "1.0",
      status: "quarantined",
      lookup: { kind: "run_id", value: RUN_ID },
      requestId: "request-1",
      runId: RUN_ID,
      reason: "integrity verification failed",
    }, read),
    {
      kind: "unavailable",
      status: "quarantined",
      reason: "integrity verification failed",
    },
  );
  assertEquals(reads, 0);
});

Deno.test("Digital Thread @3 result remains a distinct recorded authority", async () => {
  const session = await digitalThreadSession();
  const state = await displayStateFromViewerSession(session);
  assertEquals(state.kind, "result");
  if (state.kind !== "result") throw new Error("expected result state");
  assertEquals(state.result.kind, "digital-thread-static-proof");
  if (state.result.kind !== "digital-thread-static-proof") {
    throw new Error("expected Digital Thread static result projection");
  }
  assertEquals(
    state.result.authority.operation,
    "verify.run-fea-static-proof@3",
  );
  assertEquals(state.result.authority.runId, "proof-run-19");
  assertEquals(
    state.result.authority.resultArtifact.fingerprint,
    session.anchor.fingerprint,
  );
  assertEquals(state.result.metrics.maxDisplacement.value, 0.05);

  const retiredAlias = structuredClone(session);
  retiredAlias.provenance.operation = "verify.run-fea-static-proof@2";
  await assertRejects(
    () => displayStateFromViewerSession(retiredAlias),
    TypeError,
    "operation",
  );

  const wrongInput = structuredClone(session);
  wrongInput.provenance.inputArtifact.fingerprint = `sha256:${"a".repeat(64)}`;
  await assertRejects(
    () => displayStateFromViewerSession(wrongInput),
    TypeError,
    "does not match",
  );

  const tampered = structuredClone(session);
  (tampered.projection.result.metrics.maximumVonMises as { value: number })
    .value = 27.1;
  await assertRejects(
    () => displayStateFromViewerSession(tampered),
    TypeError,
    "sessionFingerprint does not match",
  );

  const changedProject = structuredClone(session);
  changedProject.basis.projectId = "project-2";
  await assertRejects(
    () => displayStateFromViewerSession(changedProject),
    TypeError,
    "sessionFingerprint does not match",
  );

  const changedAnchor = structuredClone(session);
  changedAnchor.anchor.id = "proof-run-20";
  await assertRejects(
    () => displayStateFromViewerSession(changedAnchor),
    TypeError,
    "sessionFingerprint does not match",
  );

  const changedProvenance = structuredClone(session);
  changedProvenance.provenance.evidenceArtifact.fingerprint = `sha256:${
    "9".repeat(64)
  }`;
  await assertRejects(
    () => displayStateFromViewerSession(changedProvenance),
    TypeError,
    "sessionFingerprint does not match",
  );
});

Deno.test("viewer sessions reject re-signed anchor and artifact join substitutions", async () => {
  const wrongAnchor = structuredClone(await digitalThreadSession());
  wrongAnchor.anchor.uri = `casys://isolated-output/sha256/${"a".repeat(64)}`;
  wrongAnchor.anchor.fingerprint = `sha256:${"a".repeat(64)}`;
  await resignViewerSession(wrongAnchor);
  await assertRejects(
    () => displayStateFromViewerSession(wrongAnchor),
    TypeError,
    "anchor must identify the exact provider result artifact",
  );

  const wrongResult = structuredClone(await digitalThreadSession());
  wrongResult.anchor.uri = `casys://isolated-output/sha256/${"a".repeat(64)}`;
  wrongResult.anchor.fingerprint = `sha256:${"a".repeat(64)}`;
  wrongResult.provenance.resultArtifact = {
    uri: wrongResult.anchor.uri,
    fingerprint: wrongResult.anchor.fingerprint,
  };
  await resignViewerSession(wrongResult);
  await assertRejects(
    () => displayStateFromViewerSession(wrongResult),
    TypeError,
    "does not match its result artifact fingerprint",
  );

  const wrongEvidence = structuredClone(await digitalThreadSession());
  wrongEvidence.provenance.evidenceArtifact.uri =
    `casys://calculix-isolated-execution-evidence/sha256/${"a".repeat(64)}`;
  await resignViewerSession(wrongEvidence);
  await assertRejects(
    () => displayStateFromViewerSession(wrongEvidence),
    TypeError,
    "URI and fingerprint must identify the same bytes",
  );
});

Deno.test("fleet recorded sessions join run, request, ledger and result.json", async () => {
  const session = await fleetViewerSession();
  const state = await displayStateFromViewerSession(session);
  assertEquals(state.kind, "result");
  if (state.kind !== "result") throw new Error("expected result state");
  assertEquals(state.result.kind, "static-solve-recorded");

  const wrongRequest = structuredClone(session);
  (wrongRequest.provenance as { requestId: string }).requestId = "request-2";
  await resignViewerSession(wrongRequest);
  await assertRejects(
    () => displayStateFromViewerSession(wrongRequest),
    TypeError,
    "does not match its provenance run and request identities",
  );

  const wrongResult = structuredClone(session);
  (wrongResult.projection.result.metrics.maxVonMises as { value: number })
    .value = 27.1;
  await resignViewerSession(wrongResult);
  await assertRejects(
    () => displayStateFromViewerSession(wrongResult),
    TypeError,
    "does not match its result.json fingerprint",
  );
});

Deno.test("recorded session availability states are preserved verbatim", async () => {
  const base = await digitalThreadSession();
  const unresolvedProjection = {
    status: "unresolved",
    reason: "TRACE GAP",
  } as const;
  const unresolvedSession = {
    ...base,
    basis: {
      ...base.basis,
      sessionFingerprint: `sha256:${"0".repeat(64)}`,
    },
    projection: unresolvedProjection,
  };
  unresolvedSession.basis.sessionFingerprint =
    await calculixRecordedSessionFingerprint(unresolvedSession);
  assertEquals(
    await displayStateFromViewerSession(unresolvedSession),
    { kind: "unresolved", status: "unresolved", reason: "TRACE GAP" },
  );
  const unavailableProjection = {
    status: "unavailable",
    reason: "artifact unavailable",
  } as const;
  const unavailableSession = {
    ...base,
    basis: {
      ...base.basis,
      sessionFingerprint: `sha256:${"0".repeat(64)}`,
    },
    projection: unavailableProjection,
  };
  unavailableSession.basis.sessionFingerprint =
    await calculixRecordedSessionFingerprint(unavailableSession);
  assertEquals(
    await displayStateFromViewerSession(unavailableSession),
    {
      kind: "unavailable",
      status: "unavailable",
      reason: "artifact unavailable",
    },
  );
});

Deno.test("session fingerprint rejects sparse or adorned JSON arrays", async () => {
  const sparseSession = await digitalThreadSession();
  const sparse = new Array(2);
  sparse[1] = "recorded";
  (sparseSession.projection.result.constraints as unknown as {
    fixedSelections: unknown[];
  }).fixedSelections = sparse;
  await assertRejects(
    () => calculixRecordedSessionFingerprint(sparseSession),
    TypeError,
    "dense, unadorned array",
  );

  const adornedSession = await digitalThreadSession();
  const adorned = ["recorded"] as string[] & { note?: string };
  adorned.note = "not JSON array data";
  (adornedSession.projection.result.constraints as unknown as {
    fixedSelections: unknown[];
  }).fixedSelections = adorned;
  await assertRejects(
    () => calculixRecordedSessionFingerprint(adornedSession),
    TypeError,
    "dense, unadorned array",
  );

  const ordered = await digitalThreadSession();
  const reordered = {
    projection: ordered.projection,
    provenance: ordered.provenance,
    anchor: ordered.anchor,
    basis: {
      sessionFingerprint: ordered.basis.sessionFingerprint,
      thread: ordered.basis.thread,
      subjectId: ordered.basis.subjectId,
      projectRevision: ordered.basis.projectRevision,
      projectId: ordered.basis.projectId,
    },
    kind: ordered.kind,
    schemaVersion: ordered.schemaVersion,
  };
  assertEquals(
    await calculixRecordedSessionFingerprint(ordered),
    await calculixRecordedSessionFingerprint(reordered),
  );
});

Deno.test("viewer manifest declares one App-owned whole view", () => {
  const resource = CALCULIX_VIEW_APP_MANIFEST.resources[0];
  assertEquals(resource.ownership, "whole-view");
  assertEquals(resource.acceptedActions, [VIEWER_SESSION_APPLY_ACTION]);
  assertEquals(resource.sessionSchemas, [CALCULIX_VIEWER_SESSION_SCHEMA]);
  assertEquals(
    resource.resultSchemas,
    Object.values(CALCULIX_RESULT_SCHEMA_IDS),
  );
  assertEquals("components" in resource, false);
  assertEquals(CALCULIX_APP_INFO, {
    name: CALCULIX_VIEW_APP_MANIFEST.app.id,
    version: CALCULIX_VIEW_APP_MANIFEST.app.version,
  });
});

Deno.test("results viewer keeps safe error fallbacks", () => {
  assertEquals(
    toolErrorMessage({
      content: [{ type: "text", text: "Solver unavailable" }],
    }),
    "Solver unavailable",
  );
});

Deno.test("legacy JSON text fallback remains available without weakening validation", async () => {
  assertEquals(
    await displayStateFromToolResult({
      content: [
        { type: "text", text: "Human-readable summary" },
        { type: "text", text: JSON.stringify(result) },
      ],
    }, () => Promise.reject(new Error("must not read"))),
    { kind: "result", result },
  );
  assertEquals(
    await displayStateFromToolResult({
      content: [{ type: "text", text: "Human-readable summary" }],
    }, () => Promise.reject(new Error("must not read"))),
    { kind: "empty" },
  );
});

Deno.test("viewer sessions survive pre-connect delivery and component remounts in FIFO order", async () => {
  let eventHandler: ((payload: { data: unknown }) => void) | undefined;
  let subscribedAction: string | undefined;
  const events = {
    on(action: string, handler: (payload: { data: unknown }) => void) {
      subscribedAction = action;
      eventHandler = handler;
      return () => {
        eventHandler = undefined;
      };
    },
  };
  const applied: number[] = [];
  const errors: unknown[] = [];
  const receiver = createBufferedSessionReceiver<number>({
    events,
    action: VIEWER_SESSION_APPLY_ACTION,
    async map(value) {
      await Promise.resolve();
      if (typeof value !== "number") throw new TypeError("not a number");
      return value;
    },
    onError: (error) => errors.push(error),
  });
  assertEquals(subscribedAction, VIEWER_SESSION_APPLY_ACTION);

  eventHandler?.({ data: 1 });
  eventHandler?.({ data: 2 });
  await receiver.activate(async (value) => {
    await Promise.resolve();
    applied.push(value);
  });
  // A surface remount owns no listener; later App-level actions keep flowing.
  eventHandler?.({ data: 3 });
  await receiver.drain();
  assertEquals(applied, [1, 2, 3]);

  eventHandler?.({ data: "invalid" });
  await receiver.drain();
  assertEquals(errors.length, 1);
  receiver.dispose();
  eventHandler?.({ data: 4 });
  assertEquals(applied, [1, 2, 3]);
});

Deno.test("default surface is one compact static-result card", () => {
  const catalog = advertisedComponentCatalog(CALCULIX_COMPONENT_REGISTRY);
  assertEquals(
    Object.keys(catalog.components).toSorted(),
    [CALCULIX_COMPONENT_KEYS.staticResult],
  );
  assertEquals(catalog.defaultSurface, CALCULIX_RESULTS_SURFACE);
  assertEquals(CALCULIX_RESULTS_SURFACE.layout, {
    type: "stack",
    gap: "sm",
  });
  assertEquals(CALCULIX_RESULTS_SURFACE.components, [{
    id: "static-result",
    component: CALCULIX_COMPONENT_KEYS.staticResult,
  }]);
});

Deno.test("a malformed host surface is recoverable by a later valid context", () => {
  const malformed = resolveCalculixSurface({
    [CASYS_SURFACE_CONTEXT_KEY]: {
      instanceId: "whiteboard",
      status: "ready",
      source: "requested",
      surface: {
        layout: { type: "grid", columns: 0 },
        components: [{
          id: "static-result",
          component: CALCULIX_COMPONENT_KEYS.staticResult,
        }],
      },
    },
  });
  assertEquals(malformed.ok, false);
  if (!malformed.ok) {
    assertStringIncludes(
      malformed.message,
      "host-selected component surface is invalid",
    );
  }

  assertEquals(resolveCalculixSurface({}), {
    ok: true,
    surface: CALCULIX_RESULTS_SURFACE,
  });
});

Deno.test("status projections use the shared busy-aware state primitive", async () => {
  const documentModule = await import("linkedom");
  const dom = documentModule.parseHTML("<html><body></body></html>");
  const previousDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: dom.document,
  });
  try {
    const loading = renderDisplayState({ kind: "loading" });
    assertEquals(loading.classList.contains("mcp-view-state"), true);
    assertEquals(loading.getAttribute("aria-busy"), "true");
    assertEquals(
      loading.querySelectorAll(".mcp-view-state-busy").length,
      1,
    );

    const unavailable = renderDisplayState({
      kind: "unavailable",
      status: "quarantined",
      reason: "integrity verification failed",
    });
    assertEquals(unavailable.getAttribute("data-tone"), "warning");
    assertStringIncludes(
      unavailable.textContent ?? "",
      "Recorded evidence unavailable",
    );
  } finally {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: previousDocument,
    });
  }
});

Deno.test("compact default source does not import invented verdict or bound widgets", async () => {
  const source = await Deno.readTextFile(
    new URL("./components.tsx", import.meta.url),
  );
  assertEquals(source.includes("LimitGauge"), false);
  assertEquals(source.includes("ElementVerdict"), false);
  assertEquals(source.includes("ArtifactRow"), false);
  assertEquals(source.includes("PathBar"), false);
});

Deno.test({
  name: "CalculiX default surface is one documentary SemanticElement card",
  permissions: { read: true, env: true, run: true },
  async fn() {
    await withMountedSurface(
      await digitalThreadResult(),
      {},
      async (root, mounted) => {
        assertEquals(root.querySelectorAll("[data-component]").length, 1);
        assertEquals(
          root.querySelector("[data-component]")?.getAttribute(
            "data-component",
          ),
          CALCULIX_COMPONENT_KEYS.staticResult,
        );
        const card = root.querySelector(".mcp-view-semantic-element");
        assertEquals(card?.getAttribute("data-density"), "card");
        assertEquals(card?.getAttribute("data-semantic-domain"), "calculix");
        assertEquals(
          card?.getAttribute("data-semantic-kind"),
          "digital-thread-static-proof",
        );
        assertEquals(card?.hasAttribute("data-tone"), false);
        assertEquals(
          root.querySelector("[data-element-slot=verdict]"),
          null,
        );
        assertEquals(root.querySelector(".mcp-view-limit-gauge"), null);
        assertEquals(
          root.querySelector(".mcp-view-artifact-row-verification"),
          null,
        );
        assertStringIncludes(
          root.textContent ?? "",
          "Digital Thread · documentary projection",
        );
        assertStringIncludes(root.textContent ?? "", "Documentary");
        assertEquals(
          card?.getAttribute("data-semantic-id"),
          (await digitalThreadSession()).anchor.id,
        );
        assertEquals(
          card?.getAttribute("data-basis-fingerprint"),
          (await digitalThreadSession()).anchor.fingerprint.slice(
            "sha256:".length,
          ),
        );
        assertEquals(root.textContent?.includes("CalculiX run ID"), false);
        assertEquals(root.textContent?.includes("Mesh summary"), false);
        assertEquals(root.textContent?.includes("STEP resource"), false);
        assertEquals(root.querySelector(".mcp-view-artifact-row"), null);
        assertEquals(
          root.querySelectorAll(".calculix-result-readings .mcp-view-metric")
            .length,
          2,
        );
        assertEquals(root.querySelectorAll('[data-tone="success"]').length, 0);
        assertNoInventedVerdict(root);

        await mounted.dispose();
        assertEquals(root.textContent, "");
      },
    );
  },
});

Deno.test({
  name: "ordinary static-solve card has no ArtifactRow URI and no verdict",
  permissions: { read: true, env: true, run: true },
  async fn() {
    await withMountedSurface(result, {}, (root) => {
      assertEquals(root.querySelector(".mcp-view-artifact-row"), null);
      assertEquals(
        root.querySelector("[data-element-slot=verdict]"),
        null,
      );
      assertEquals(root.querySelector(".mcp-view-limit-gauge"), null);
      assertEquals(root.textContent?.includes("STEP source"), false);
      assertEquals(root.textContent?.includes("/exports/bracket.step"), false);
      assertStringIncludes(root.textContent ?? "", "Maximum displacement");
      assertStringIncludes(root.textContent ?? "", "mm");
      assertStringIncludes(root.textContent ?? "", "MPa");
      assertNoInventedVerdict(root);
    });
  },
});

Deno.test({
  name:
    "recorded static-solve card stays one result object without nested STEP",
  permissions: { read: true, env: true, run: true },
  async fn() {
    const fixture = await recordedFixture();
    await withMountedSurface(
      {
        ...recordedDocument,
        run: fixture.lookup.run,
      },
      {},
      (root) => {
        assertEquals(root.querySelector(".mcp-view-artifact-row"), null);
        assertEquals(
          root.textContent?.includes(`${RUN_URI}/input.step`),
          false,
        );
        assertStringIncludes(root.textContent ?? "", "Result artifact");
        assertEquals(
          root.querySelector("[data-element-slot=verdict]"),
          null,
        );
        assertNoInventedVerdict(root);
      },
    );
  },
});

async function withMountedSurface(
  data: StaticResultsViewData,
  hostContext: Record<string, unknown>,
  run: (
    root: HTMLElement,
    mounted: Awaited<ReturnType<typeof mountComponentSurface>>,
  ) => void | Promise<void>,
): Promise<void> {
  const documentModule = await import("linkedom");
  const dom = documentModule.parseHTML(
    "<html><body><div id=root></div></body></html>",
  );
  const previousDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: dom.document,
  });
  try {
    const root = dom.document.getElementById(
      "root",
    ) as unknown as HTMLElement;
    const mounted = await mountComponentSurface({
      root,
      registry: CALCULIX_COMPONENT_REGISTRY,
      data,
      appContext: componentContext,
      hostContext: hostContext as PreactSurfaceContext<
        StaticResultsViewData
      >["hostContext"],
    });
    try {
      await run(root, mounted);
    } finally {
      await mounted.dispose();
    }
  } finally {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: previousDocument,
    });
  }
}

function assertNoInventedVerdict(root: HTMLElement): void {
  const text = (root.textContent ?? "").toLowerCase();
  for (const claim of ["pass", "fail", "safe", "verified", "adequate"]) {
    assertEquals(
      text.includes(claim),
      false,
      `compact surface must not invent ${claim}`,
    );
  }
}

async function digitalThreadResult(): Promise<StaticResultsViewData> {
  const state = await displayStateFromViewerSession(
    await digitalThreadSession(),
  );
  if (state.kind !== "result") throw new Error("expected result state");
  return state.result;
}

async function recordedFixture() {
  const resultText = `${canonicalTestJson(recordedDocument)}\n`;
  const resultSha256 = await sha256Hex(resultText);
  const specifications = [
    ["input.step", "model/step"],
    ["request.json", "application/json"],
    ["mesh.geo", "text/plain"],
    ["mesh.inp", "text/plain"],
    ["gmsh.log", "text/plain"],
    ["job.inp", "text/plain"],
    ["ccx.log", "text/plain"],
    ["job.dat", "text/plain"],
    ["result.json", "application/json"],
  ] as const;
  const artifacts = specifications.map(([name, mimeType], index) => ({
    name,
    uri: `${RUN_URI}/${name}`,
    mimeType,
    bytes: name === "input.step"
      ? 4256
      : name === "result.json"
      ? new TextEncoder().encode(resultText).byteLength
      : 10 + index,
    sha256: name === "input.step"
      ? STEP_SHA256
      : name === "request.json"
      ? "c".repeat(64)
      : name === "result.json"
      ? resultSha256
      : (index + 1).toString(16).repeat(64),
  }));
  const run = {
    schemaVersion: "2.0",
    state: "completed",
    runId: RUN_ID,
    requestId: "request-1",
    requestSha256: "c".repeat(64),
    inputArtifact: recordedDocument.inputArtifact,
    createdAt: "2026-08-31T09:15:00.000Z",
    artifacts,
  } as const;
  return {
    resultText,
    lookup: {
      schemaVersion: "1.0",
      status: "completed",
      lookup: { kind: "run_id", value: RUN_ID },
      requestId: "request-1",
      runId: RUN_ID,
      run,
    } as const,
    resource: {
      contents: [{
        uri: `${RUN_URI}/result.json`,
        mimeType: "application/json",
        text: resultText,
      }],
    },
  };
}

async function digitalThreadSession() {
  const projection = {
    status: "available",
    result: {
      schemaVersion: "calculix-isolated-static-result/1.0",
      requestId: "proof-request-19",
      executionIdentity: {
        schemaVersion: "1.0",
        profile: { id: "calculix-static-proof-v1", version: "1.0.0" },
        wrapper: { id: "calculix-static-proof-v1", version: "1.0.0" },
        lowering: { id: "calculix.static.abaqus-deck", version: "1.0" },
        engines: {
          gmsh: { command: "gmsh", version: "4.13.1" },
          ccx: { command: "ccx", version: "2.21" },
        },
        image: { status: "bound-by-isolated-runner-receipt" },
      },
      inputArtifact: {
        mediaType: "model/step",
        byteCount: 4256,
        sha256: STEP_SHA256,
      },
      mesh: structuredClone(result.mesh),
      constraints: structuredClone(result.constraints),
      metrics: {
        maximumDisplacement: {
          value: 0.05,
          unit: "mm",
          nodeId: 26,
          vectorMm: [0.03, 0.04, 0],
        },
        maximumVonMises: structuredClone(result.metrics.maxVonMises),
      },
    },
  } as const;
  const resultFingerprint = await calculixIsolatedStaticResultFingerprint(
    projection.result,
  );
  const resultDigest = resultFingerprint.slice("sha256:".length);
  const session = {
    schemaVersion: CALCULIX_VIEWER_SESSION_SCHEMA,
    kind: "calculix.static-proof",
    basis: {
      projectId: "project-1",
      projectRevision: 19,
      subjectId: "part-bracket",
      thread: { id: "thread-1", revision: 42 },
      sessionFingerprint: `sha256:${"0".repeat(64)}`,
    },
    anchor: {
      kind: "artifact",
      id: `isolated-result-${resultDigest}`,
      uri: `casys://isolated-output/sha256/${resultDigest}`,
      fingerprint: resultFingerprint,
    },
    provenance: {
      kind: "digital-thread-operation",
      operation: "verify.run-fea-static-proof@3",
      runId: "proof-run-19",
      inputArtifact: {
        uri: `casys://isolated-output/sha256/${STEP_SHA256}`,
        mediaType: "model/step",
        fingerprint: `sha256:${STEP_SHA256}`,
        bytes: 4256,
      },
      resultArtifact: {
        uri: `casys://isolated-output/sha256/${resultDigest}`,
        fingerprint: resultFingerprint,
      },
      evidenceArtifact: {
        uri: `casys://calculix-isolated-execution-evidence/sha256/${
          "e".repeat(64)
        }`,
        fingerprint: `sha256:${"e".repeat(64)}`,
      },
    },
    projection,
  };
  session.basis.sessionFingerprint = await calculixRecordedSessionFingerprint(
    session,
  );
  return session;
}

async function fleetViewerSession() {
  const fixture = await recordedFixture();
  const resultArtifact = fixture.lookup.run.artifacts.find((artifact) =>
    artifact.name === "result.json"
  );
  if (!resultArtifact) throw new Error("fixture result.json is missing");
  const artifactIdentity = {
    uri: resultArtifact.uri,
    fingerprint: `sha256:${resultArtifact.sha256}`,
  };
  const session = {
    schemaVersion: CALCULIX_VIEWER_SESSION_SCHEMA,
    kind: "calculix.static-proof",
    basis: {
      projectId: "project-1",
      projectRevision: 19,
      subjectId: "part-bracket",
      thread: { id: "thread-1", revision: 42 },
      sessionFingerprint: `sha256:${"0".repeat(64)}`,
    },
    anchor: {
      kind: "artifact",
      id: resultArtifact.name,
      ...artifactIdentity,
    },
    provenance: {
      kind: "mcp-calculix-recorded-run",
      server: { package: "@casys/mcp-calculix", version: "0.8.4" },
      tool: { name: "calculix_solve_static_recorded", version: "1.0" },
      runId: fixture.lookup.run.runId,
      requestId: fixture.lookup.run.requestId,
      resultArtifact: artifactIdentity,
    },
    projection: {
      status: "available",
      result: { ...recordedDocument, run: fixture.lookup.run },
    },
  };
  await resignViewerSession(session);
  return session;
}

async function resignViewerSession(
  session: { basis: { sessionFingerprint: string } } & Record<string, unknown>,
): Promise<void> {
  session.basis.sessionFingerprint = await calculixRecordedSessionFingerprint(
    session,
  );
}

function canonicalTestJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalTestJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${
      Object.keys(record).toSorted().map((key) =>
        `${JSON.stringify(key)}:${canonicalTestJson(record[key])}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const exact = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(exact).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", exact);
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
