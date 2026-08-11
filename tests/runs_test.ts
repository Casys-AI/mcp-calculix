import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createHash } from "node:crypto";
import { createCalculixServer } from "../server.ts";
import { snapshotStepArtifact } from "../src/api/input-artifact.ts";
import { buildDeck, parseDat } from "../src/api/ccx.ts";
import { buildGeoScript } from "../src/api/gmsh.ts";
import {
  RECORDED_STATIC_RUN_GET_OUTPUT_SCHEMA,
  RECORDED_STATIC_RUN_OUTPUT_SCHEMA,
  STATIC_SOLVE_RECORDED_OUTPUT_SCHEMA,
} from "../src/results.ts";
import {
  CalculixRunIntegrityError,
  CalculixRunOutcomeUnknownError,
  CalculixRunStore,
  canonicalJson,
  RECORDED_ARTIFACTS,
  type RecordedStaticExecutionIdentity,
  type RecordedStaticRun,
  type RecordedStaticRunPayload,
  resolveRecordedStaticRequest,
} from "../src/runs.ts";
import { createRecordedStaticTools } from "../src/tools/solve.ts";

const STEP_BYTES = new TextEncoder().encode("abc");
const STEP_SHA256 =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

function requestJson(requestId: string, marker = "one"): string {
  return canonicalJson({
    execution_identity: testExecutionIdentity(),
    element_order: 1,
    expected_step_sha256: STEP_SHA256,
    fixed: ["FIX"],
    loads: [{ selection: "LOAD", force_n: [0, 0, -10] }],
    material: { e_mpa: 70_000, nu: 0.3 },
    mesh_size_mm: 2,
    request_id: requestId,
    selections: [
      { name: "FIX", box: { min: [0, 0, 0], max: [1, 1, 1] } },
      { name: "LOAD", box: { min: [1, 0, 0], max: [2, 1, 1] } },
    ],
    step_path: `/server-owned-test/${marker}.step`,
    timeout_ms: 1_000,
  }) + "\n";
}

function payload(
  requestId: string,
  runId: string,
  marker = "one",
): RecordedStaticRunPayload {
  const meshInp = fakeMeshInp();
  const jobDat = fakeDat();
  const result = parseDat(jobDat);
  const request = JSON.parse(requestJson(requestId, marker)) as {
    selections: Array<
      {
        name: string;
        box: { min: [number, number, number]; max: [number, number, number] };
      }
    >;
    mesh_size_mm: number;
    element_order: 1 | 2;
    material: { e_mpa: number; nu: number };
    fixed: string[];
    loads: Array<{ selection: string; force_n: [number, number, number] }>;
  };
  return {
    requestJson: requestJson(requestId, marker),
    inputArtifact: { sha256: STEP_SHA256, bytes: STEP_BYTES.length },
    inputStep: STEP_BYTES,
    meshGeo: buildGeoScript({
      stepPath: "input.step",
      selections: request.selections,
      meshSizeMm: request.mesh_size_mm,
      elementOrder: request.element_order,
      timeoutMs: 1_000,
    }),
    meshInp,
    gmshDiagnostics: `gmsh ${marker}\n`,
    jobInp: buildDeck({
      inpText: meshInp,
      maxNodeId: 2,
      material: { eMpa: request.material.e_mpa, nu: request.material.nu },
      fixed: request.fixed,
      loads: request.loads.map((load) => ({
        selection: load.selection,
        totalForceN: load.force_n,
      })),
      nodesPerSet: { FIX: 1, LOAD: 1 },
    }),
    ccxDiagnostics: `ccx ${marker}\n`,
    jobDat,
    resultJson: `${
      canonicalJson({
        schemaVersion: "2.0",
        kind: "static-solve-recorded",
        inputArtifact: {
          uri: `casys://calculix/runs/${runId}/input.step`,
          mimeType: "model/step",
          sha256: STEP_SHA256,
          bytes: STEP_BYTES.length,
        },
        mesh: {
          nodes: 2,
          elements: 1,
          nodesPerSelection: { FIX: 1, LOAD: 1 },
        },
        constraints: {
          fixedSelections: ["FIX"],
          loads: [{ selection: "LOAD", forceN: [0, 0, -10] }],
        },
        metrics: {
          maxDisplacement: {
            value: result.maxDisplacement.magnitudeMm,
            unit: "mm",
            nodeId: result.maxDisplacement.nodeId,
            vectorMm: result.maxDisplacement.vectorMm,
          },
          maxVonMises: {
            value: result.maxVonMises.mpa,
            unit: "MPa",
            elementId: result.maxVonMises.elementId,
          },
        },
      })
    }\n`,
  };
}

async function recordStaticRun(
  store: CalculixRunStore,
  requestId: string,
  marker = "one",
): Promise<RecordedStaticRun> {
  const decision = await store.claimRequest(
    requestId,
    requestJson(requestId, marker),
  );
  if (decision.outcome === "completed") return decision.run;
  return await store.completeClaim(
    decision.claim,
    payload(requestId, decision.claim.runId, marker),
  );
}

Deno.test("recorded static run persists exact blob/text resources and survives restart", async () => {
  const runsDirectory = await Deno.makeTempDir({ prefix: "calculix-runs-" });
  try {
    const store = new CalculixRunStore({ runsDirectory });
    const run = await recordStaticRun(store, "attempt-1");
    assertEquals(run.schemaVersion, "2.0");
    assertEquals(run.state, "completed");
    assertEquals(run.artifacts.map((artifact) => artifact.name), [
      ...RECORDED_ARTIFACTS,
    ]);
    assertEquals(run.inputArtifact, {
      uri: `casys://calculix/runs/${run.runId}/input.step`,
      mimeType: "model/step",
      sha256: STEP_SHA256,
      bytes: 3,
    });
    const step = await store.readArtifact(run.artifacts[0].uri);
    assert("blob" in step);
    assertEquals(step.blob, "YWJj");
    assertEquals(step.mimeType, "model/step");
    const request = await store.readArtifact(run.artifacts[1].uri);
    assert("text" in request);
    assertEquals(request.text, requestJson("attempt-1"));
    assertEquals(request.mimeType, "application/json");

    const restarted = new CalculixRunStore({ runsDirectory });
    assertEquals(restarted.get(run.runId), run);
    assertEquals(
      await restarted.findByRequest(
        "attempt-1",
        requestJson("attempt-1"),
      ),
      run,
    );
  } finally {
    await Deno.remove(runsDirectory, { recursive: true });
  }
});

Deno.test("recorded artifacts fail closed on blob/text tamper, missing file, and traversal URI", async () => {
  const runsDirectory = await Deno.makeTempDir({ prefix: "calculix-runs-" });
  try {
    const store = new CalculixRunStore({ runsDirectory });
    const run = await recordStaticRun(store, "attempt-2");
    await Deno.writeFile(
      join(runsDirectory, run.runId, "input.step"),
      new Uint8Array([0, 1, 2]),
    );
    assertThrows(
      () => store.readArtifact(run.artifacts[0].uri),
      CalculixRunIntegrityError,
      "integrity verification",
    );
    assertThrows(
      () =>
        store.readArtifact(`casys://calculix/runs/${run.runId}/../ledger.json`),
      CalculixRunIntegrityError,
      "Resource not found",
    );
    await Deno.remove(join(runsDirectory, run.runId, "job.dat"));
    const dat = run.artifacts.find((artifact) => artifact.name === "job.dat");
    assert(dat);
    assertThrows(
      () => store.readArtifact(dat.uri),
      CalculixRunIntegrityError,
      "unavailable",
    );
  } finally {
    await Deno.remove(runsDirectory, { recursive: true });
  }
});

Deno.test("startup rejects hash-coherent semantic tamper in result and request evidence", async () => {
  const foreignInputRoot = await Deno.makeTempDir({
    prefix: "calculix-semantic-input-",
  });
  const metricRoot = await Deno.makeTempDir({
    prefix: "calculix-semantic-metric-",
  });
  const requestRoot = await Deno.makeTempDir({
    prefix: "calculix-semantic-request-",
  });
  try {
    const foreignInputStore = new CalculixRunStore({
      runsDirectory: foreignInputRoot,
    });
    const foreignInputRun = await recordStaticRun(
      foreignInputStore,
      "semantic-input",
    );
    await rewriteAttestedJson(
      foreignInputRoot,
      foreignInputRun,
      "result.json",
      (value) => {
        (value.inputArtifact as Record<string, unknown>).sha256 = "f".repeat(
          64,
        );
      },
    );
    assertThrows(
      () => new CalculixRunStore({ runsDirectory: foreignInputRoot }),
      CalculixRunIntegrityError,
      "does not exactly match the run STEP identity",
    );

    const metricStore = new CalculixRunStore({ runsDirectory: metricRoot });
    const metricRun = await recordStaticRun(metricStore, "semantic-metric");
    await rewriteAttestedJson(
      metricRoot,
      metricRun,
      "result.json",
      (value) => {
        const metrics = value.metrics as Record<string, unknown>;
        (metrics.maxDisplacement as Record<string, unknown>).value = 0.2;
      },
    );
    assertThrows(
      () => new CalculixRunStore({ runsDirectory: metricRoot }),
      CalculixRunIntegrityError,
      "value disagrees with vectorMm",
    );

    const requestStore = new CalculixRunStore({ runsDirectory: requestRoot });
    const requestRun = await recordStaticRun(
      requestStore,
      "semantic-request",
    );
    await rewriteAttestedJson(
      requestRoot,
      requestRun,
      "request.json",
      (value) => {
        value.unexpected = "foreign-field";
      },
    );
    assertThrows(
      () => new CalculixRunStore({ runsDirectory: requestRoot }),
      CalculixRunIntegrityError,
      "unexpected or missing fields",
    );
  } finally {
    await Promise.all([
      Deno.remove(foreignInputRoot, { recursive: true }),
      Deno.remove(metricRoot, { recursive: true }),
      Deno.remove(requestRoot, { recursive: true }),
    ]);
  }
});

Deno.test("Promise.all claim contention elects one owner and completed retry returns the same run", async () => {
  const runsDirectory = await Deno.makeTempDir({ prefix: "calculix-claim-" });
  try {
    const store = new CalculixRunStore({ runsDirectory });
    const claims = await Promise.allSettled([
      store.claimRequest("same-process", requestJson("same-process")),
      store.claimRequest("same-process", requestJson("same-process")),
    ]);
    const winner = claims.find((result) =>
      result.status === "fulfilled" && result.value.outcome === "claimed"
    );
    const loser = claims.find((result) => result.status === "rejected");
    assert(winner?.status === "fulfilled");
    assert(winner.value.outcome === "claimed");
    assert(loser?.status === "rejected");
    assert(loser.reason instanceof CalculixRunOutcomeUnknownError);
    assertEquals(loser.reason.state, "dispatched");

    const run = await store.completeClaim(
      winner.value.claim,
      payload("same-process", winner.value.claim.runId),
    );
    const retry = await store.claimRequest(
      "same-process",
      requestJson("same-process"),
    );
    assertEquals(retry, { outcome: "completed", run });
  } finally {
    await Deno.remove(runsDirectory, { recursive: true });
  }
});

Deno.test("two ready provider processes cannot dispatch the same request_id", async () => {
  const runsDirectory = await Deno.makeTempDir({ prefix: "calculix-process-" });
  try {
    const command = (id: string) =>
      new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "tests/fixtures/claim_worker.ts",
          runsDirectory,
          "cross-process",
          requestJson("cross-process"),
          id,
        ],
        cwd: new URL("..", import.meta.url),
        stdout: "piped",
        stderr: "piped",
      }).spawn();
    const one = command("one");
    const two = command("two");
    await waitForPaths([
      join(runsDirectory, "ready-one"),
      join(runsDirectory, "ready-two"),
    ]);
    await Deno.writeTextFile(join(runsDirectory, "start"), "start\n");
    const outputs = await Promise.all([one.output(), two.output()]);
    for (const output of outputs) {
      assertEquals(
        output.success,
        true,
        new TextDecoder().decode(output.stderr),
      );
    }
    const results = outputs.map((output) =>
      JSON.parse(new TextDecoder().decode(output.stdout).trim()) as {
        outcome: string;
        state?: string;
      }
    );
    assertEquals(
      results.filter((result) => result.outcome === "claimed").length,
      1,
    );
    assertEquals(
      results.filter((result) => result.outcome === "refused").length,
      1,
    );
    assertEquals(
      results.find((result) => result.outcome === "refused")?.state,
      "dispatched",
    );
  } finally {
    await Deno.remove(runsDirectory, { recursive: true });
  }
});

Deno.test("atomic claim publication keeps the final owner directory hidden until claim.json is durable", async () => {
  const runsDirectory = await Deno.makeTempDir({
    prefix: "calculix-atomic-claim-publication-",
  });
  let releasePublication: () => void = () => {};
  let candidateDirectory = "";
  let requestDirectory = "";
  const publicationGate = new Promise<void>((resolve) => {
    releasePublication = resolve;
  });
  let candidateReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    candidateReady = resolve;
  });
  try {
    const store = new CalculixRunStore({
      runsDirectory,
      beforeClaimPublication: async (candidate, request) => {
        candidateDirectory = candidate;
        requestDirectory = request;
        const candidateClaim = JSON.parse(
          await Deno.readTextFile(join(candidate, "claim.json")),
        ) as Record<string, unknown>;
        assertEquals(candidateClaim.requestId, "atomic-owner");
        assertThrows(() => Deno.statSync(request), Deno.errors.NotFound);
        candidateReady();
        await publicationGate;
      },
    });
    const claimPromise = store.claimRequest(
      "atomic-owner",
      requestJson("atomic-owner"),
    );
    await ready;
    assertThrows(() => Deno.statSync(requestDirectory), Deno.errors.NotFound);
    assertEquals(Deno.statSync(candidateDirectory).isDirectory, true);
    releasePublication();
    const result = await claimPromise;
    assert(result.outcome === "claimed");
    assertEquals(
      JSON.parse(
        await Deno.readTextFile(join(requestDirectory, "claim.json")),
      ).requestId,
      "atomic-owner",
    );
    assertThrows(
      () => Deno.statSync(candidateDirectory),
      Deno.errors.NotFound,
    );
  } finally {
    releasePublication();
    await Deno.remove(runsDirectory, { recursive: true });
  }
});

Deno.test("legacy mkdir-before-claim crash is recoverable as outcome_unknown and never not_found", async () => {
  const runsDirectory = await Deno.makeTempDir({
    prefix: "calculix-empty-claim-",
  });
  try {
    new CalculixRunStore({ runsDirectory });
    const requestId = "mkdir-crash";
    await Deno.mkdir(join(
      runsDirectory,
      ".requests",
      `q-${base64Url(requestId)}`,
    ));
    const restarted = new CalculixRunStore({ runsDirectory });
    const recovery = restarted.lookupRun({
      kind: "request_id",
      value: requestId,
    });
    assert(recovery.status === "outcome_unknown");
    assertEquals("runId" in recovery, false);
    assertEquals(recovery.requestId, requestId);
    assert(recovery.reason.includes("redispatch is forbidden"));
    const runGet = createRecordedStaticTools(restarted).find((tool) =>
      tool.name === "calculix_run_get"
    );
    assert(runGet);
    const wire = (await runGet.handler({ request_id: requestId }) as {
      structuredContent: Record<string, unknown>;
    }).structuredContent;
    assertEquals(wire, recovery);
    const validate = new Ajv2020({ strict: false }).compile(
      RECORDED_STATIC_RUN_GET_OUTPUT_SCHEMA,
    );
    assertEquals(validate(wire), true, JSON.stringify(validate.errors));
    await assertRejects(
      () => restarted.claimRequest(requestId, requestJson(requestId)),
      CalculixRunOutcomeUnknownError,
      "quarantined",
    );
    assertEquals(
      restarted.lookupRun({ kind: "request_id", value: requestId }),
      recovery,
    );
  } finally {
    await Deno.remove(runsDirectory, { recursive: true });
  }
});

Deno.test("dispatched state never redispatches and a digest collision is rejected", async () => {
  const runsDirectory = await Deno.makeTempDir({
    prefix: "calculix-dispatched-",
  });
  try {
    const first = new CalculixRunStore({ runsDirectory });
    await first.claimRequest("crashed", requestJson("crashed"));
    const restarted = new CalculixRunStore({ runsDirectory });
    await assertRejects(
      () => restarted.claimRequest("crashed", requestJson("crashed")),
      CalculixRunOutcomeUnknownError,
      "outcome is unknown",
    );
    await assertRejects(
      () => restarted.claimRequest("crashed", requestJson("crashed", "other")),
      CalculixRunIntegrityError,
      "different canonical request digest",
    );
  } finally {
    await Deno.remove(runsDirectory, { recursive: true });
  }
});

Deno.test("invalid recorded physics is rejected before claim, STEP snapshot, Gmsh, or ccx", async () => {
  const directory = await Deno.makeTempDir({ prefix: "calculix-preflight-" });
  const stepPath = join(directory, "part.step");
  await Deno.writeFile(stepPath, STEP_BYTES);
  const counts = { snapshot: 0, mesh: 0, solve: 0 };
  try {
    const store = new CalculixRunStore({
      runsDirectory: join(directory, "runs"),
    });
    const tool = createRecordedStaticTools(store, {
      resolveExecutionIdentity: () => Promise.resolve(testExecutionIdentity()),
      snapshotStepArtifact: async (...args) => {
        counts.snapshot++;
        return await snapshotStepArtifact(...args);
      },
      meshStepRecorded: (options) => {
        counts.mesh++;
        return Promise.resolve(fakeMesh(options));
      },
      solveDeckRecorded: () => {
        counts.solve++;
        return Promise.resolve(fakeSolve());
      },
    }).find((candidate) => candidate.name === "calculix_solve_static_recorded");
    assert(tool);
    const base = recordedToolArgs(stepPath, "invalid-nu");
    const invalidNu = {
      ...base,
      material: { e_mpa: 70_000, nu: 0.5 },
    };
    const invalidBoxSelections = structuredClone(
      base.selections as Array<Record<string, unknown>>,
    );
    invalidBoxSelections[0].box = {
      min: [1, 0, 0],
      max: [0, 1, 1],
    };
    const duplicateSelections = structuredClone(
      base.selections as Array<Record<string, unknown>>,
    );
    duplicateSelections[1].name = "FIX";
    const cases = [
      { args: invalidNu, requestId: "invalid-nu" },
      {
        args: {
          ...base,
          request_id: "invalid-box",
          selections: invalidBoxSelections,
        },
        requestId: "invalid-box",
      },
      {
        args: {
          ...base,
          request_id: "invalid-duplicate-selection",
          selections: duplicateSelections,
        },
        requestId: "invalid-duplicate-selection",
      },
      {
        args: {
          ...base,
          request_id: "invalid-duplicate-fixed",
          fixed: ["FIX", "FIX"],
        },
        requestId: "invalid-duplicate-fixed",
      },
    ];
    for (const invalid of cases) {
      await assertRejects(
        () => Promise.resolve(tool.handler(invalid.args)),
        CalculixRunIntegrityError,
      );
      assertEquals(store.getRequestClaim(invalid.requestId), undefined);
    }
    assertEquals(counts, { snapshot: 0, mesh: 0, solve: 0 });
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("post-ledger crash reconciles in the same process without a second snapshot, Gmsh, or ccx", async () => {
  const runsDirectory = await Deno.makeTempDir({
    prefix: "calculix-reconcile-",
  });
  const inputPath = join(runsDirectory, "part.step");
  await Deno.writeFile(inputPath, STEP_BYTES);
  let durableRunId = "";
  const counts = { snapshot: 0, mesh: 0, solve: 0 };
  try {
    const store = new CalculixRunStore({
      runsDirectory: join(runsDirectory, "runs"),
      afterLedgerCommit: (run) => {
        durableRunId = run.runId;
        throw new Error("injected crash after ledger rename");
      },
    });
    const tool = createRecordedStaticTools(store, {
      resolveExecutionIdentity: () => Promise.resolve(testExecutionIdentity()),
      snapshotStepArtifact: async (...args) => {
        counts.snapshot++;
        assertEquals(
          store.getRequestClaim("reconcile-request")?.state,
          "dispatched",
        );
        return await snapshotStepArtifact(...args);
      },
      meshStepRecorded: (options) => {
        counts.mesh++;
        assertEquals(
          store.getRequestClaim("reconcile-request")?.state,
          "dispatched",
        );
        return Promise.resolve(fakeMesh(options));
      },
      solveDeckRecorded: () => {
        counts.solve++;
        assertEquals(
          store.getRequestClaim("reconcile-request")?.state,
          "dispatched",
        );
        return Promise.resolve(fakeSolve());
      },
    }).find((candidate) => candidate.name === "calculix_solve_static_recorded");
    assert(tool);
    const args = recordedToolArgs(inputPath, "reconcile-request");
    await assertRejects(
      () => Promise.resolve(tool.handler(args)),
      Error,
      "injected crash after ledger rename",
    );
    assertEquals(counts, { snapshot: 1, mesh: 1, solve: 1 });

    const retried = await tool.handler(args) as {
      structuredContent: Record<string, unknown>;
    };
    assertEquals(counts, { snapshot: 1, mesh: 1, solve: 1 });
    assertEquals(
      (retried.structuredContent.run as { runId: string }).runId,
      durableRunId,
    );
    const ajv = new Ajv2020({ strict: false });
    assertEquals(
      ajv.compile(STATIC_SOLVE_RECORDED_OUTPUT_SCHEMA)(
        retried.structuredContent,
      ),
      true,
    );
    await assertRejects(
      () =>
        Promise.resolve(tool.handler({
          ...args,
          mesh_size_mm: 3,
        })),
      CalculixRunIntegrityError,
      "different canonical request digest",
    );
    assertEquals(counts, { snapshot: 1, mesh: 1, solve: 1 });
  } finally {
    await Deno.remove(runsDirectory, { recursive: true });
  }
});

Deno.test("post-ledger reconciliation enforces retention before returning the recovered run", async () => {
  const runsDirectory = await Deno.makeTempDir({
    prefix: "calculix-reconcile-bound-",
  });
  try {
    const seed = new CalculixRunStore({ runsDirectory, maxRuns: 1 });
    const oldRun = await recordStaticRun(seed, "old-run");
    let recoveredRunId = "";
    const recovering = new CalculixRunStore({
      runsDirectory,
      maxRuns: 1,
      afterLedgerCommit: (run) => {
        recoveredRunId = run.runId;
        throw new Error("crash before claim completion and retention");
      },
    });
    await assertRejects(
      () => recordStaticRun(recovering, "new-run"),
      Error,
      "crash before claim completion",
    );
    assertEquals(recovering.list(), [oldRun]);

    const retry = await recovering.claimRequest(
      "new-run",
      requestJson("new-run"),
    );
    assert(retry.outcome === "completed");
    assertEquals(retry.run.runId, recoveredRunId);
    assertEquals(recovering.list(), [retry.run]);
    assertThrows(
      () => recovering.getByRequestId("old-run"),
      CalculixRunOutcomeUnknownError,
      "is evicted",
    );
    assertThrows(
      () => Deno.statSync(join(runsDirectory, oldRun.runId)),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(runsDirectory, { recursive: true });
  }
});

Deno.test("reconciliation refuses a recovered run that retention immediately evicts", async () => {
  const runsDirectory = await Deno.makeTempDir({
    prefix: "calculix-reconcile-old-",
  });
  try {
    const store = new CalculixRunStore({
      runsDirectory,
      maxRuns: 1,
      afterLedgerCommit: (run) => {
        if (run.requestId === "recovered-older") {
          throw new Error("crash with an older durable ledger");
        }
      },
    });
    const newer = await recordStaticRun(store, "already-newer");
    await assertRejects(
      () => recordStaticRun(store, "recovered-older"),
      Error,
      "older durable ledger",
    );
    const claim = store.getRequestClaim("recovered-older");
    assert(claim);
    const olderTimestamp = new Date(Date.parse(newer.createdAt) - 1_000)
      .toISOString();
    const claimTimestamp = new Date(Date.parse(olderTimestamp) - 1)
      .toISOString();
    const ledgerPath = join(runsDirectory, claim.runId, "ledger.json");
    const ledger = JSON.parse(await Deno.readTextFile(ledgerPath)) as Record<
      string,
      unknown
    >;
    ledger.createdAt = olderTimestamp;
    await Deno.writeTextFile(ledgerPath, `${canonicalJson(ledger)}\n`);
    const claimPath = join(
      runsDirectory,
      ".requests",
      `q-${base64Url(claim.requestId)}`,
      "claim.json",
    );
    const persistedClaim = JSON.parse(
      await Deno.readTextFile(claimPath),
    ) as Record<string, unknown>;
    persistedClaim.createdAt = claimTimestamp;
    persistedClaim.updatedAt = claimTimestamp;
    await Deno.writeTextFile(claimPath, `${canonicalJson(persistedClaim)}\n`);

    await assertRejects(
      () =>
        store.claimRequest(
          "recovered-older",
          requestJson("recovered-older"),
        ),
      CalculixRunOutcomeUnknownError,
      "is evicted",
    );
    assertEquals(store.list(), [newer]);
    assertThrows(
      () => Deno.statSync(join(runsDirectory, claim.runId)),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(runsDirectory, { recursive: true });
  }
});

Deno.test("startup removes hard-crash staging orphans before enforcing maxRuns", async () => {
  const runsDirectory = await Deno.makeTempDir({
    prefix: "calculix-staging-restart-",
  });
  try {
    const seed = new CalculixRunStore({ runsDirectory, maxRuns: 1 });
    const first = await recordStaticRun(seed, "staging-first");
    const orphan = join(runsDirectory, ".staging", "hard-crash-orphan");
    await Deno.mkdir(orphan);
    await Deno.writeTextFile(join(orphan, "partial-job.dat"), "partial\n");
    const claimCandidate = join(
      runsDirectory,
      ".requests",
      ".claim-candidate-hard-crash",
    );
    await Deno.mkdir(claimCandidate);
    await Deno.writeTextFile(join(claimCandidate, "claim.json"), "partial\n");

    const restarted = new CalculixRunStore({ runsDirectory, maxRuns: 1 });
    assertEquals([...Deno.readDirSync(join(runsDirectory, ".staging"))], []);
    assertThrows(() => Deno.statSync(claimCandidate), Deno.errors.NotFound);
    assertEquals(restarted.get(first.runId), first);

    const second = await recordStaticRun(restarted, "staging-second");
    assertEquals(restarted.list().map((run) => run.runId), [second.runId]);
    assertEquals(
      restarted.lookupRun({ kind: "request_id", value: "staging-first" })
        .status,
      "evicted",
    );
    assertEquals([...Deno.readDirSync(join(runsDirectory, ".staging"))], []);
  } finally {
    await Deno.remove(runsDirectory, { recursive: true });
  }
});

Deno.test("startup never removes staging while a live writer lock exists", async () => {
  const runsDirectory = await Deno.makeTempDir({
    prefix: "calculix-staging-live-owner-",
  });
  try {
    new CalculixRunStore({ runsDirectory });
    const liveStaging = join(runsDirectory, ".staging", "live-owner");
    await Deno.mkdir(liveStaging);
    await Deno.writeTextFile(join(liveStaging, "in-flight"), "owned\n");
    const lock = await Deno.open(join(runsDirectory, ".writer.lock"), {
      read: true,
      write: true,
    });
    await lock.lock(true);
    try {
      new CalculixRunStore({ runsDirectory });
      assertEquals(Deno.statSync(liveStaging).isDirectory, true);
    } finally {
      await lock.unlock();
      lock.close();
    }

    new CalculixRunStore({ runsDirectory });
    assertThrows(() => Deno.statSync(liveStaging), Deno.errors.NotFound);
  } finally {
    await Deno.remove(runsDirectory, { recursive: true });
  }
});

Deno.test("restart rejects duplicate and malformed canonical ledgers", async () => {
  const duplicateRoot = await Deno.makeTempDir({
    prefix: "calculix-duplicate-",
  });
  const malformedRoot = await Deno.makeTempDir({
    prefix: "calculix-malformed-",
  });
  try {
    const duplicateStore = new CalculixRunStore({
      runsDirectory: duplicateRoot,
    });
    const run = await recordStaticRun(duplicateStore, "duplicate");
    await duplicateRunDirectory(duplicateRoot, run);
    assertThrows(
      () => new CalculixRunStore({ runsDirectory: duplicateRoot }),
      CalculixRunIntegrityError,
      "Duplicate durable ledgers",
    );

    const malformedStore = new CalculixRunStore({
      runsDirectory: malformedRoot,
    });
    const malformed = await recordStaticRun(malformedStore, "malformed");
    const ledgerPath = join(malformedRoot, malformed.runId, "ledger.json");
    const ledger = JSON.parse(await Deno.readTextFile(ledgerPath)) as Record<
      string,
      unknown
    >;
    ledger.unexpected = true;
    await Deno.writeTextFile(ledgerPath, `${canonicalJson(ledger)}\n`);
    assertThrows(
      () => new CalculixRunStore({ runsDirectory: malformedRoot }),
      CalculixRunIntegrityError,
      "unexpected or missing fields",
    );
  } finally {
    await Deno.remove(duplicateRoot, { recursive: true });
    await Deno.remove(malformedRoot, { recursive: true });
  }
});

Deno.test("eviction unregisters resources and leaves an honest durable evicted tombstone", async () => {
  const runsDirectory = await Deno.makeTempDir({
    prefix: "calculix-eviction-",
  });
  try {
    const store = new CalculixRunStore({ runsDirectory, maxRuns: 1 });
    const { app } = createCalculixServer({ logger: () => {}, runStore: store });
    const port = freePort();
    const http = await app.startHttp({
      port,
      hostname: "127.0.0.1",
      onListen: () => {},
    });
    const url = `http://127.0.0.1:${port}/mcp`;
    try {
      const first = await recordStaticRun(store, "retained-1", "first");
      assert(
        first.artifacts.every((artifact) => app.hasResource(artifact.uri)),
      );
      const second = await recordStaticRun(store, "retained-2", "second");
      assert(
        first.artifacts.every((artifact) => !app.hasResource(artifact.uri)),
      );
      assert(
        second.artifacts.every((artifact) => app.hasResource(artifact.uri)),
      );
      assertEquals(store.list(), [second]);
      const listed = await rpc(url, "resources/list");
      const resources = listed.result.resources as Array<{ uri: string }>;
      assertEquals(
        resources.some((resource) => resource.uri === first.artifacts[0].uri),
        false,
      );
      assertEquals(
        resources.filter((resource) =>
          resource.uri.startsWith(`casys://calculix/runs/${second.runId}/`)
        ).length,
        9,
      );
      const removedRead = await rpcRaw(url, "resources/read", {
        uri: first.artifacts[0].uri,
      });
      assert("error" in removedRead);
      assertThrows(
        () => store.getByRequestId("retained-1"),
        CalculixRunOutcomeUnknownError,
        "is evicted",
      );
      await assertRejects(
        () => recordStaticRun(store, "retained-1", "first"),
        CalculixRunOutcomeUnknownError,
        "is evicted",
      );
      assertEquals(store.list(), [second]);
    } finally {
      await http.shutdown();
    }
  } finally {
    await Deno.remove(runsDirectory, { recursive: true });
  }
});

Deno.test("startup hides and cleans a ledger left after an evicted tombstone crash", async () => {
  const runsDirectory = await Deno.makeTempDir({
    prefix: "calculix-eviction-crash-",
  });
  try {
    const store = new CalculixRunStore({ runsDirectory });
    const run = await recordStaticRun(store, "eviction-crash");
    const requestsPath = join(runsDirectory, ".requests");
    const claimDirectory = [...Deno.readDirSync(requestsPath)].find((entry) =>
      entry.isDirectory
    );
    assert(claimDirectory);
    const claimPath = join(requestsPath, claimDirectory.name, "claim.json");
    const claim = JSON.parse(await Deno.readTextFile(claimPath)) as Record<
      string,
      unknown
    >;
    claim.state = "evicted";
    claim.updatedAt = new Date().toISOString();
    claim.reason = "injected crash after tombstone";
    await Deno.writeTextFile(claimPath, `${canonicalJson(claim)}\n`);
    // Model a process dying midway through recursive physical cleanup.
    await Deno.remove(join(runsDirectory, run.runId, "job.dat"));

    const restarted = new CalculixRunStore({ runsDirectory });
    assertEquals(restarted.list(), []);
    assertThrows(
      () => restarted.getByRequestId("eviction-crash"),
      CalculixRunOutcomeUnknownError,
      "is evicted",
    );
    await assertRejects(
      () => Deno.stat(join(runsDirectory, run.runId)),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(runsDirectory, { recursive: true });
  }
});

Deno.test("post-commit resource registration failure is durable and run_get republishes atomically", async () => {
  const runsDirectory = await Deno.makeTempDir({
    prefix: "calculix-register-retry-",
  });
  try {
    const warnings: string[] = [];
    const store = new CalculixRunStore({ runsDirectory });
    const { app, toolsClient } = createCalculixServer({
      logger: (message) => warnings.push(message),
      runStore: store,
    });
    const registerResources = app.registerResources.bind(app);
    let fail = true;
    app.registerResources = (resources, handlers) => {
      if (
        fail &&
        resources.some((resource) => resource.uri.startsWith("casys://"))
      ) {
        fail = false;
        throw new Error("injected registration failure");
      }
      registerResources(resources, handlers);
    };
    const run = await recordStaticRun(store, "registration-retry");
    assertEquals(store.get(run.runId), run);
    assert(run.artifacts.every((artifact) => !app.hasResource(artifact.uri)));
    assert(warnings.some((warning) => warning.includes("run_get")));

    app.registerResources = registerResources;
    const runGet = toolsClient.buildHandlersMap().get("calculix_run_get");
    assert(runGet);
    await runGet({ run_id: run.runId });
    assert(run.artifacts.every((artifact) => app.hasResource(artifact.uri)));
  } finally {
    await Deno.remove(runsDirectory, { recursive: true });
  }
});

Deno.test("an exact recorded solve retry republishes without another native execution", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "calculix-exact-republish-",
  });
  const stepPath = join(directory, "part.step");
  await Deno.writeFile(stepPath, STEP_BYTES);
  const counts = { snapshot: 0, mesh: 0, solve: 0 };
  try {
    const store = new CalculixRunStore({
      runsDirectory: join(directory, "runs"),
    });
    const { app } = createCalculixServer({ logger: () => {}, runStore: store });
    const registerResources = app.registerResources.bind(app);
    let fail = true;
    app.registerResources = (resources, handlers) => {
      if (
        fail &&
        resources.some((resource) => resource.uri.startsWith("casys://"))
      ) {
        fail = false;
        throw new Error("injected first publication failure");
      }
      registerResources(resources, handlers);
    };
    const tool = createRecordedStaticTools(store, {
      resolveExecutionIdentity: () => Promise.resolve(testExecutionIdentity()),
      snapshotStepArtifact: async (...args) => {
        counts.snapshot++;
        return await snapshotStepArtifact(...args);
      },
      meshStepRecorded: (options) => {
        counts.mesh++;
        return Promise.resolve(fakeMesh(options));
      },
      solveDeckRecorded: () => {
        counts.solve++;
        return Promise.resolve(fakeSolve());
      },
    }).find((candidate) => candidate.name === "calculix_solve_static_recorded");
    assert(tool);
    const args = recordedToolArgs(stepPath, "exact-republish");
    const first = await tool.handler(args) as {
      structuredContent: { run: RecordedStaticRun };
    };
    assertEquals(counts, { snapshot: 1, mesh: 1, solve: 1 });
    assert(
      first.structuredContent.run.artifacts.every((artifact) =>
        !app.hasResource(artifact.uri)
      ),
    );

    app.registerResources = registerResources;
    const retry = await tool.handler(args) as {
      structuredContent: { run: RecordedStaticRun };
    };
    assertEquals(retry.structuredContent.run, first.structuredContent.run);
    assertEquals(counts, { snapshot: 1, mesh: 1, solve: 1 });
    assert(
      retry.structuredContent.run.artifacts.every((artifact) =>
        app.hasResource(artifact.uri)
      ),
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("mcp-server 0.26 rejects a bad middle resource without a partial run surface", async () => {
  const runsDirectory = await Deno.makeTempDir({ prefix: "calculix-batch-" });
  try {
    const store = new CalculixRunStore({ runsDirectory });
    const { app, toolsClient } = createCalculixServer({
      logger: () => {},
      runStore: store,
    });
    const port = freePort();
    const http = await app.startHttp({
      port,
      hostname: "127.0.0.1",
      onListen: () => {},
    });
    const url = `http://127.0.0.1:${port}/mcp`;
    const subscription = await subscribeToResourceChanges(url);
    try {
      await waitUntil(
        () =>
          subscription.events.some((frame) =>
            frame.includes("notifications/subscriptions/acknowledged")
          ),
        "resource subscription acknowledgement",
      );
      assertEquals(resourceChangeCount(subscription.events), 0);
      const registerResources = app.registerResources.bind(app);
      app.registerResources = (resources, handlers) => {
        const middle = Math.floor(resources.length / 2);
        registerResources(
          resources.map((resource, index) =>
            index === middle ? { ...resource, size: -1 } : resource
          ),
          handlers,
        );
      };
      const run = await recordStaticRun(store, "batch-failure");
      assert(run.artifacts.every((artifact) => !app.hasResource(artifact.uri)));
      const failedList = await rpc(url, "resources/list");
      assertEquals(
        (failedList.result.resources as Array<{ uri: string }>).some((
          resource,
        ) => resource.uri.startsWith(`casys://calculix/runs/${run.runId}/`)),
        false,
      );
      await assertResourceChangeCountStays(subscription.events, 0);

      app.registerResources = registerResources;
      const runGet = toolsClient.buildHandlersMap().get("calculix_run_get");
      assert(runGet);
      await runGet({ request_id: run.requestId });
      assert(run.artifacts.every((artifact) => app.hasResource(artifact.uri)));
      await waitUntil(
        () => resourceChangeCount(subscription.events) === 1,
        "one successful batch notification",
      );
      await assertResourceChangeCountStays(subscription.events, 1);
    } finally {
      await subscription.close();
      await http.shutdown();
    }
  } finally {
    await Deno.remove(runsDirectory, { recursive: true });
  }
});

Deno.test("MCP resources/list and resources/read expose exact STEP blob and UTF-8 text", async () => {
  const runsDirectory = await Deno.makeTempDir({ prefix: "calculix-wire-" });
  const seed = new CalculixRunStore({ runsDirectory });
  const run = await recordStaticRun(seed, "wire-read");
  const { app } = createCalculixServer({ logger: () => {}, runsDirectory });
  const port = freePort();
  const http = await app.startHttp({
    port,
    hostname: "127.0.0.1",
    onListen: () => {},
  });
  const url = `http://127.0.0.1:${port}/mcp`;
  try {
    const listed = await rpc(url, "resources/list");
    const resources = listed.result.resources as Array<Record<string, unknown>>;
    assertEquals(
      resources.filter((resource) =>
        (resource.uri as string).startsWith(
          `casys://calculix/runs/${run.runId}/`,
        )
      ).length,
      9,
    );
    const step = await rpc(url, "resources/read", {
      uri: run.artifacts[0].uri,
    });
    const stepContent =
      (step.result.contents as Array<Record<string, unknown>>)[0];
    assertEquals(stepContent.blob, "YWJj");
    assertEquals(stepContent.mimeType, "model/step");
    const request = await rpc(url, "resources/read", {
      uri: run.artifacts[1].uri,
    });
    const requestContent =
      (request.result.contents as Array<Record<string, unknown>>)[0];
    assertEquals(requestContent.text, requestJson("wire-read"));
    assertEquals(requestContent.mimeType, "application/json");
    const runGet = await rpc(url, "tools/call", {
      name: "calculix_run_get",
      arguments: { request_id: "wire-read" },
    });
    assertEquals(
      (runGet.result.structuredContent as Record<string, unknown>)
        .schemaVersion,
      "1.0",
    );
    assertEquals(
      (runGet.result.structuredContent as Record<string, unknown>).status,
      "completed",
    );
    const dispatched = await seed.claimRequest(
      "wire-dispatched",
      requestJson("wire-dispatched"),
    );
    assert(dispatched.outcome === "claimed");
    const pendingGet = await rpc(url, "tools/call", {
      name: "calculix_run_get",
      arguments: { request_id: "wire-dispatched" },
    });
    const pending = pendingGet.result.structuredContent as Record<
      string,
      unknown
    >;
    assertEquals(pending.status, "dispatched");
    assertEquals("run" in pending, false);
    assertEquals(pending.requestId, "wire-dispatched");
    assertEquals(pending.runId, dispatched.claim.runId);
    const missingGet = await rpc(url, "tools/call", {
      name: "calculix_run_get",
      arguments: { request_id: "wire-not-found" },
    });
    const missing = missingGet.result.structuredContent as Record<
      string,
      unknown
    >;
    assertEquals(missing.status, "not_found");
    assertEquals("run" in missing, false);
    assertEquals(missing.lookup, {
      kind: "request_id",
      value: "wire-not-found",
    });

    await Deno.writeTextFile(
      join(runsDirectory, run.runId, "request.json"),
      "tampered\n",
    );
    const tampered = await rpcRaw(url, "resources/read", {
      uri: run.artifacts[1].uri,
    });
    assert("error" in tampered);
  } finally {
    await http.shutdown();
    await Deno.remove(runsDirectory, { recursive: true });
  }
});

Deno.test("recorded input/output schemas are closed at every governed nesting", async () => {
  const directory = await Deno.makeTempDir({ prefix: "calculix-schema-" });
  const inputPath = join(directory, "part.step");
  await Deno.writeFile(inputPath, STEP_BYTES);
  try {
    const store = new CalculixRunStore({
      runsDirectory: join(directory, "runs"),
    });
    const tools = createRecordedStaticTools(store, {
      resolveExecutionIdentity: () => Promise.resolve(testExecutionIdentity()),
      snapshotStepArtifact,
      meshStepRecorded: (options) => Promise.resolve(fakeMesh(options)),
      solveDeckRecorded: () => Promise.resolve(fakeSolve()),
    });
    const tool = tools.find((candidate) =>
      candidate.name === "calculix_solve_static_recorded"
    );
    assert(tool);
    const ajv = new Ajv2020({ strict: false });
    const validateInput = ajv.compile(tool.inputSchema);
    const validInput = recordedToolArgs(inputPath, "schema-request");
    assertEquals(validateInput(validInput), true);
    assertEquals(validateInput({ ...validInput, extra: true }), false);
    assertEquals(validateInput({ ...validInput, mesh_size_mm: 0 }), false);
    assertEquals(validateInput({ ...validInput, timeout_ms: 1.5 }), false);
    assertEquals(
      validateInput({ ...validInput, material: { e_mpa: 70_000, nu: 0.5 } }),
      false,
    );
    assertEquals(
      validateInput({
        ...validInput,
        material: { ...(validInput.material as object), extra: true },
      }),
      false,
    );
    const selections = structuredClone(
      validInput.selections as Array<Record<string, unknown>>,
    );
    selections[0].box = { ...(selections[0].box as object), extra: true };
    assertEquals(validateInput({ ...validInput, selections }), false);
    selections[0] = {
      ...selections[0],
      name: "invalid-name",
      box: { min: [0, 0, 0], max: [1, 1, 1] },
    };
    assertEquals(validateInput({ ...validInput, selections }), false);
    const withoutDigest = { ...validInput };
    delete withoutDigest.expected_step_sha256;
    assertEquals(validateInput(withoutDigest), false);
    const runGet = tools.find((candidate) =>
      candidate.name === "calculix_run_get"
    );
    assert(runGet);
    const validateRunGetInput = ajv.compile(runGet.inputSchema);
    assertEquals(
      validateRunGetInput({ run_id: `r-${crypto.randomUUID()}` }),
      true,
    );
    assertEquals(
      validateRunGetInput({
        run_id: `r-${crypto.randomUUID()}`,
        request_id: "ambiguous",
      }),
      false,
    );

    const result = await tool.handler(validInput) as {
      structuredContent: Record<string, unknown>;
    };
    const validateOutput = ajv.compile(STATIC_SOLVE_RECORDED_OUTPUT_SCHEMA);
    assertEquals(
      validateOutput(result.structuredContent),
      true,
      JSON.stringify(validateOutput.errors),
    );
    const extraNested = structuredClone(result.structuredContent);
    (extraNested.run as { inputArtifact: Record<string, unknown> })
      .inputArtifact.extra = true;
    assertEquals(validateOutput(extraNested), false);
    const wrongMime = structuredClone(result.structuredContent);
    (wrongMime.run as { artifacts: Array<Record<string, unknown>> })
      .artifacts[0].mimeType = "text/plain";
    assertEquals(validateOutput(wrongMime), false);
    const validateRun = ajv.compile(RECORDED_STATIC_RUN_OUTPUT_SCHEMA);
    assertEquals(validateRun(result.structuredContent.run), true);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("recorded completion rejects causally disconnected mesh, deck, dat, and result evidence", async () => {
  const root = await Deno.makeTempDir({ prefix: "calculix-causal-precommit-" });
  try {
    const cases: Array<{
      name: string;
      mutate: (value: RecordedStaticRunPayload) => void;
      expected: string;
    }> = [
      {
        name: "geo",
        mutate: (value) => {
          value.meshGeo = 'Merge "/private/random/input.step";\n';
        },
        expected: "stable lowering",
      },
      {
        name: "mesh",
        mutate: (value) => {
          value.meshInp += "3, 2, 0, 0\n";
        },
        expected: "mesh counts",
      },
      {
        name: "deck",
        mutate: (value) => {
          value.jobInp += "** forged suffix\n";
        },
        expected: "deterministic deck",
      },
      {
        name: "result",
        mutate: (value) => {
          const result = JSON.parse(value.resultJson) as Record<
            string,
            unknown
          >;
          const displacement = (result.metrics as Record<string, unknown>)
            .maxDisplacement as Record<string, unknown>;
          displacement.value = 0.2;
          displacement.vectorMm = [0, 0, -0.2];
          value.resultJson = `${canonicalJson(result)}\n`;
        },
        expected: "derived exactly",
      },
      {
        name: "dat",
        mutate: (value) => {
          value.jobDat = value.jobDat.replace("-0.1", "-0.2");
        },
        expected: "derived exactly",
      },
    ];
    for (const current of cases) {
      const store = new CalculixRunStore({
        runsDirectory: join(root, current.name),
      });
      const request = requestJson(`causal-${current.name}`);
      const decision = await store.claimRequest(
        `causal-${current.name}`,
        request,
      );
      assert(decision.outcome === "claimed");
      const evidence = payload(
        `causal-${current.name}`,
        decision.claim.runId,
      );
      current.mutate(evidence);
      await assertRejects(
        () => store.completeClaim(decision.claim, evidence),
        CalculixRunIntegrityError,
        current.expected,
      );
      assertEquals(store.list(), []);
      assertEquals(
        store.getRequestClaim(`causal-${current.name}`)?.state,
        "quarantined",
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("startup replay rejects a hash-coherent causal deck substitution", async () => {
  const runsDirectory = await Deno.makeTempDir({
    prefix: "calculix-causal-replay-",
  });
  try {
    const store = new CalculixRunStore({ runsDirectory });
    const run = await recordStaticRun(store, "causal-replay");
    await rewriteAttestedText(
      runsDirectory,
      run,
      "job.inp",
      (text) => `${text}** substituted\n`,
    );
    assertThrows(
      () => new CalculixRunStore({ runsDirectory }),
      CalculixRunIntegrityError,
      "deterministic deck",
    );
  } finally {
    await Deno.remove(runsDirectory, { recursive: true });
  }
});

Deno.test("recorded request seals effective defaults and engine identity after its preflight claim", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "calculix-resolved-request-",
  });
  const stepPath = join(directory, "part.step");
  await Deno.writeFile(stepPath, STEP_BYTES);
  let identity: RecordedStaticExecutionIdentity = testExecutionIdentity();
  let probes = 0;
  try {
    const store = new CalculixRunStore({
      runsDirectory: join(directory, "runs"),
    });
    const tool = createRecordedStaticTools(store, {
      resolveExecutionIdentity: () => {
        probes++;
        return Promise.resolve(identity);
      },
      meshStepRecorded: (options) => Promise.resolve(fakeMesh(options)),
      solveDeckRecorded: () => Promise.resolve(fakeSolve()),
    }).find((candidate) => candidate.name === "calculix_solve_static_recorded");
    assert(tool);
    const args = recordedToolArgs(stepPath, "resolved-defaults");
    delete args.element_order;
    delete args.timeout_ms;
    const first = await tool.handler(args) as {
      structuredContent: { run: RecordedStaticRun };
    };
    const request = JSON.parse(
      await Deno.readTextFile(
        join(
          directory,
          "runs",
          first.structuredContent.run.runId,
          "request.json",
        ),
      ),
    ) as Record<string, unknown>;
    assertEquals(request.element_order, 2);
    assertEquals(request.timeout_ms, 120_000);
    assertEquals(request.execution_identity, identity);
    assertEquals(probes, 1);

    identity = {
      ...identity,
      engines: {
        ...identity.engines,
        gmsh: { command: "gmsh", version: "test-gmsh-2" },
      },
    };
    const retry = await tool.handler(args) as {
      structuredContent: { run: RecordedStaticRun };
    };
    assertEquals(retry.structuredContent.run, first.structuredContent.run);
    assertEquals(probes, 1);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("recorded handler elects durably before probing and concurrent retries execute once", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "calculix-recorded-claim-order-",
  });
  const stepPath = join(directory, "part.step");
  await Deno.writeFile(stepPath, STEP_BYTES);
  const counts = { probe: 0, snapshot: 0, mesh: 0, solve: 0 };
  const ordering: string[] = [];
  try {
    const store = new CalculixRunStore({
      runsDirectory: join(directory, "runs"),
    });
    const args = recordedToolArgs(stepPath, "claim-before-probe");
    const tool = createRecordedStaticTools(store, {
      resolveExecutionIdentity: async () => {
        counts.probe++;
        ordering.push(
          `probe:${store.getRequestClaim(args.request_id as string)?.state}`,
        );
        await Promise.resolve();
        return testExecutionIdentity();
      },
      snapshotStepArtifact: async (...snapshotArgs) => {
        counts.snapshot++;
        ordering.push("snapshot");
        return await snapshotStepArtifact(...snapshotArgs);
      },
      meshStepRecorded: (options) => {
        counts.mesh++;
        ordering.push("mesh");
        return Promise.resolve(fakeMesh(options));
      },
      solveDeckRecorded: () => {
        counts.solve++;
        ordering.push("solve");
        return Promise.resolve(fakeSolve());
      },
    }).find((candidate) => candidate.name === "calculix_solve_static_recorded");
    assert(tool);

    const outcomes = await Promise.all([
      Promise.resolve(tool.handler(args)).then(
        () => ({ status: "fulfilled" as const }),
        (reason) => ({ status: "rejected" as const, reason }),
      ),
      Promise.resolve(tool.handler(args)).then(
        () => ({ status: "fulfilled" as const }),
        (reason) => ({ status: "rejected" as const, reason }),
      ),
    ]);
    assertEquals(
      outcomes.filter((outcome) => outcome.status === "fulfilled").length,
      1,
    );
    assertEquals(
      outcomes.filter((outcome) => outcome.status === "rejected").length,
      1,
    );
    const loser = outcomes.find((outcome) => outcome.status === "rejected");
    assert(loser?.status === "rejected");
    assert(loser.reason instanceof CalculixRunOutcomeUnknownError);
    assertEquals(counts, { probe: 1, snapshot: 1, mesh: 1, solve: 1 });
    assertEquals(ordering[0], "probe:dispatched");
    assert(ordering.indexOf("snapshot") > ordering.indexOf(ordering[0]));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("recorded dispatched, completed, quarantined, and evicted retries do not probe", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "calculix-recorded-retry-effects-",
  });
  const stepPath = join(directory, "part.step");
  await Deno.writeFile(stepPath, STEP_BYTES);
  const counts = { probe: 0, snapshot: 0, mesh: 0, solve: 0 };
  const resetCounts = () =>
    Object.assign(counts, {
      probe: 0,
      snapshot: 0,
      mesh: 0,
      solve: 0,
    });
  try {
    const store = new CalculixRunStore({
      runsDirectory: join(directory, "runs"),
      maxRuns: 1,
    });
    const tool = createRecordedStaticTools(store, {
      resolveExecutionIdentity: () => {
        counts.probe++;
        return Promise.resolve(testExecutionIdentity());
      },
      snapshotStepArtifact: async (...snapshotArgs) => {
        counts.snapshot++;
        return await snapshotStepArtifact(...snapshotArgs);
      },
      meshStepRecorded: (options) => {
        counts.mesh++;
        return Promise.resolve(fakeMesh(options));
      },
      solveDeckRecorded: () => {
        counts.solve++;
        return Promise.resolve(fakeSolve());
      },
    }).find((candidate) => candidate.name === "calculix_solve_static_recorded");
    assert(tool);

    const dispatchedArgs = recordedToolArgs(stepPath, "retry-dispatched");
    const dispatched = await store.claimPreflightRequest(
      "retry-dispatched",
      preflightRequestJson(dispatchedArgs),
    );
    assert(dispatched.outcome === "claimed");
    await assertRejects(
      () => Promise.resolve(tool.handler(dispatchedArgs)),
      CalculixRunOutcomeUnknownError,
      "already dispatched",
    );
    assertEquals(counts, { probe: 0, snapshot: 0, mesh: 0, solve: 0 });

    const quarantinedArgs = recordedToolArgs(stepPath, "retry-quarantined");
    const quarantined = await store.claimPreflightRequest(
      "retry-quarantined",
      preflightRequestJson(quarantinedArgs),
    );
    assert(quarantined.outcome === "claimed");
    await store.quarantineClaim(
      quarantined.claim,
      "injected pre-execution failure",
    );
    await assertRejects(
      () => Promise.resolve(tool.handler(quarantinedArgs)),
      CalculixRunOutcomeUnknownError,
      "quarantined",
    );
    assertEquals(counts, { probe: 0, snapshot: 0, mesh: 0, solve: 0 });

    const completedArgs = recordedToolArgs(stepPath, "retry-completed");
    await tool.handler(completedArgs);
    resetCounts();
    await tool.handler(completedArgs);
    assertEquals(counts, { probe: 0, snapshot: 0, mesh: 0, solve: 0 });

    await tool.handler(recordedToolArgs(stepPath, "eviction-winner"));
    resetCounts();
    await assertRejects(
      () => Promise.resolve(tool.handler(completedArgs)),
      CalculixRunOutcomeUnknownError,
      "evicted",
    );
    assertEquals(counts, { probe: 0, snapshot: 0, mesh: 0, solve: 0 });
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("recorded preflight digest conflicts fail before identity probing", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "calculix-recorded-digest-before-probe-",
  });
  const stepPath = join(directory, "part.step");
  await Deno.writeFile(stepPath, STEP_BYTES);
  const counts = { probe: 0, snapshot: 0, mesh: 0, solve: 0 };
  try {
    const store = new CalculixRunStore({
      runsDirectory: join(directory, "runs"),
    });
    const original = recordedToolArgs(stepPath, "different-before-probe");
    const claimed = await store.claimPreflightRequest(
      "different-before-probe",
      preflightRequestJson(original),
    );
    assert(claimed.outcome === "claimed");
    const conflicting = { ...original, mesh_size_mm: 3 };
    const tool = createRecordedStaticTools(store, {
      resolveExecutionIdentity: () => {
        counts.probe++;
        return Promise.resolve(testExecutionIdentity());
      },
      snapshotStepArtifact: async (...snapshotArgs) => {
        counts.snapshot++;
        return await snapshotStepArtifact(...snapshotArgs);
      },
      meshStepRecorded: (options) => {
        counts.mesh++;
        return Promise.resolve(fakeMesh(options));
      },
      solveDeckRecorded: () => {
        counts.solve++;
        return Promise.resolve(fakeSolve());
      },
    }).find((candidate) => candidate.name === "calculix_solve_static_recorded");
    assert(tool);
    await assertRejects(
      () => Promise.resolve(tool.handler(conflicting)),
      CalculixRunIntegrityError,
      "different canonical request digest",
    );
    assertEquals(counts, { probe: 0, snapshot: 0, mesh: 0, solve: 0 });
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("recorded identity or sealing failures quarantine the preflight claim without solving", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "calculix-recorded-seal-failure-",
  });
  const stepPath = join(directory, "part.step");
  await Deno.writeFile(stepPath, STEP_BYTES);
  try {
    for (
      const current of [
        {
          requestId: "identity-probe-failure",
          resolve: () => Promise.reject(new Error("injected identity failure")),
        },
        {
          requestId: "identity-seal-failure",
          resolve: () =>
            Promise.resolve({
              ...testExecutionIdentity(),
              server: { package: "@casys/mcp-calculix", version: "" },
            } as unknown as RecordedStaticExecutionIdentity),
        },
      ]
    ) {
      const counts = { probe: 0, snapshot: 0, mesh: 0, solve: 0 };
      const store = new CalculixRunStore({
        runsDirectory: join(directory, current.requestId),
      });
      const tool = createRecordedStaticTools(store, {
        resolveExecutionIdentity: () => {
          counts.probe++;
          return current.resolve();
        },
        snapshotStepArtifact: async (...snapshotArgs) => {
          counts.snapshot++;
          return await snapshotStepArtifact(...snapshotArgs);
        },
        meshStepRecorded: (options) => {
          counts.mesh++;
          return Promise.resolve(fakeMesh(options));
        },
        solveDeckRecorded: () => {
          counts.solve++;
          return Promise.resolve(fakeSolve());
        },
      }).find((candidate) =>
        candidate.name === "calculix_solve_static_recorded"
      );
      assert(tool);
      const args = recordedToolArgs(stepPath, current.requestId);
      await assertRejects(() => Promise.resolve(tool.handler(args)));
      assertEquals(counts, { probe: 1, snapshot: 0, mesh: 0, solve: 0 });
      assertEquals(
        store.getRequestClaim(current.requestId)?.state,
        "quarantined",
      );
      await assertRejects(
        () => Promise.resolve(tool.handler(args)),
        CalculixRunOutcomeUnknownError,
        "quarantined",
      );
      assertEquals(counts, { probe: 1, snapshot: 0, mesh: 0, solve: 0 });
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("calculix_run_get has a closed status union without message parsing", async () => {
  const runsDirectory = await Deno.makeTempDir({
    prefix: "calculix-run-get-status-",
  });
  try {
    const store = new CalculixRunStore({ runsDirectory });
    const tools = createRecordedStaticTools(store);
    const runGet = tools.find((tool) => tool.name === "calculix_run_get");
    assert(runGet);
    const validate = new Ajv2020({ strict: false }).compile(
      RECORDED_STATIC_RUN_GET_OUTPUT_SCHEMA,
    );
    const completedRun = await recordStaticRun(store, "status-completed");
    const completed =
      (await runGet.handler({ request_id: "status-completed" }) as {
        structuredContent: Record<string, unknown>;
      }).structuredContent;
    assertEquals(completed.status, "completed");
    assertEquals(
      (completed.run as RecordedStaticRun).runId,
      completedRun.runId,
    );
    assertEquals(validate(completed), true, JSON.stringify(validate.errors));

    const dispatched = await store.claimRequest(
      "status-dispatched",
      requestJson("status-dispatched"),
    );
    assert(dispatched.outcome === "claimed");
    const pending =
      (await runGet.handler({ request_id: "status-dispatched" }) as {
        structuredContent: Record<string, unknown>;
      }).structuredContent;
    assertEquals(pending.status, "dispatched");
    assertEquals("run" in pending, false);
    assertEquals(validate(pending), true, JSON.stringify(validate.errors));

    await store.quarantineClaim(
      dispatched.claim,
      "fixture failed before native work",
    );
    const quarantined =
      (await runGet.handler({ run_id: dispatched.claim.runId }) as {
        structuredContent: Record<string, unknown>;
      }).structuredContent;
    assertEquals(quarantined.status, "quarantined");
    assertEquals("run" in quarantined, false);
    assertEquals(validate(quarantined), true, JSON.stringify(validate.errors));

    const absent = (await runGet.handler({ request_id: "not-known" }) as {
      structuredContent: Record<string, unknown>;
    }).structuredContent;
    assertEquals(absent.status, "not_found");
    assertEquals("run" in absent, false);
    assertEquals(validate(absent), true, JSON.stringify(validate.errors));
  } finally {
    await Deno.remove(runsDirectory, { recursive: true });
  }
});

Deno.test("serialized completion never acknowledges an already evicted run at maxRuns one", async () => {
  const runsDirectory = await Deno.makeTempDir({
    prefix: "calculix-ack-eviction-",
  });
  try {
    const store = new CalculixRunStore({ runsDirectory, maxRuns: 1 });
    const [firstClaim, secondClaim] = await Promise.all([
      store.claimRequest("ack-first", requestJson("ack-first")),
      store.claimRequest("ack-second", requestJson("ack-second")),
    ]);
    assert(firstClaim.outcome === "claimed");
    assert(secondClaim.outcome === "claimed");
    const acknowledgements: string[] = [];
    await Promise.all([
      store.completeClaim(
        firstClaim.claim,
        payload("ack-first", firstClaim.claim.runId),
      )
        .then((run) => {
          assertEquals(store.get(run.runId), run);
          acknowledgements.push(run.runId);
        }),
      store.completeClaim(
        secondClaim.claim,
        payload("ack-second", secondClaim.claim.runId),
      )
        .then((run) => {
          assertEquals(store.get(run.runId), run);
          acknowledgements.push(run.runId);
        }),
    ]);
    assertEquals(acknowledgements.length, 2);
    assertEquals(store.list().length, 1);
  } finally {
    await Deno.remove(runsDirectory, { recursive: true });
  }
});

function recordedToolArgs(
  stepPath: string,
  requestId: string,
): Record<string, unknown> {
  return {
    request_id: requestId,
    step_path: stepPath,
    expected_step_sha256: STEP_SHA256,
    mesh_size_mm: 2,
    element_order: 1,
    material: { e_mpa: 70_000, nu: 0.3 },
    selections: [
      { name: "FIX", box: { min: [0, 0, 0], max: [1, 1, 1] } },
      { name: "LOAD", box: { min: [1, 0, 0], max: [2, 1, 1] } },
    ],
    fixed: ["FIX"],
    loads: [{ selection: "LOAD", force_n: [0, 0, -10] }],
    timeout_ms: 1_000,
  };
}

function fakeMesh(options: {
  selections: Array<{
    name: string;
    box: {
      min: [number, number, number];
      max: [number, number, number];
    };
  }>;
  meshSizeMm: number;
  elementOrder: 1 | 2;
  timeoutMs: number;
}) {
  const inpText = fakeMeshInp();
  return {
    mesh: {
      inpText,
      nodeCount: 2,
      elementCount: 1,
      maxNodeId: 2,
      nodesPerSet: { FIX: 1, LOAD: 1 },
    },
    artifacts: {
      geoText: buildGeoScript({
        stepPath: "input.step",
        selections: options.selections,
        meshSizeMm: options.meshSizeMm,
        elementOrder: options.elementOrder,
        timeoutMs: options.timeoutMs,
      }),
      inputStepSha256: STEP_SHA256,
      inputStepBytes: STEP_BYTES.length,
      diagnostics: "gmsh ok\n",
      cleanedInpText: inpText,
    },
  };
}

function fakeSolve() {
  const datText = fakeDat();
  return {
    result: parseDat(datText),
    datText,
    diagnostics: "ccx ok\n",
  };
}

function fakeMeshInp(): string {
  return "*NODE\n1, 0, 0, 0\n2, 1, 0, 0\n*ELEMENT, TYPE=C3D4, ELSET=PART\n1, 1, 2, 1, 2\n*NSET,NSET=FIX\n1\n*NSET,NSET=LOAD\n2\n";
}

function fakeDat(): string {
  return "displacements\n2 0 0 -0.1\nstresses\n1 1 12.5 0 0 0 0 0\n";
}

function testExecutionIdentity() {
  return {
    schema_version: "1.0",
    server: { package: "@casys/mcp-calculix", version: "0.6.0" },
    method: { id: "calculix_solve_static_recorded", version: "1.0" },
    lowering: { id: "calculix.static.abaqus-deck", version: "1.0" },
    engines: {
      gmsh: { command: "gmsh", version: "test-gmsh-1" },
      ccx: { command: "ccx", version: "test-ccx-1" },
    },
    image: { status: "unattested" },
  } as const;
}

function preflightRequestJson(args: Record<string, unknown>): string {
  return canonicalJson(
    resolveRecordedStaticRequest(args, testPreflightExecutionIdentity()).value,
  ) + "\n";
}

function testPreflightExecutionIdentity(): RecordedStaticExecutionIdentity {
  return {
    schema_version: "1.0",
    server: { package: "@casys/mcp-calculix", version: "preflight" },
    method: { id: "calculix_solve_static_recorded", version: "1.0" },
    lowering: { id: "calculix.static.abaqus-deck", version: "1.0" },
    engines: {
      gmsh: { command: "gmsh", version: "preflight" },
      ccx: { command: "ccx", version: "preflight" },
    },
    image: { status: "unattested" },
  };
}

async function rewriteAttestedJson(
  runsDirectory: string,
  run: RecordedStaticRun,
  name: "request.json" | "result.json",
  mutate: (value: Record<string, unknown>) => void,
): Promise<void> {
  const artifactPath = join(runsDirectory, run.runId, name);
  const value = JSON.parse(await Deno.readTextFile(artifactPath)) as Record<
    string,
    unknown
  >;
  mutate(value);
  const text = `${canonicalJson(value)}\n`;
  const bytes = new TextEncoder().encode(text);
  await Deno.writeTextFile(artifactPath, text);

  const ledgerPath = join(runsDirectory, run.runId, "ledger.json");
  const ledger = JSON.parse(await Deno.readTextFile(ledgerPath)) as {
    requestSha256: string;
    artifacts: Array<{ name: string; bytes: number; sha256: string }>;
  };
  const artifact = ledger.artifacts.find((candidate) =>
    candidate.name === name
  );
  assert(artifact);
  artifact.bytes = bytes.length;
  artifact.sha256 = sha256Hex(bytes);
  if (name === "request.json") {
    ledger.requestSha256 = artifact.sha256;
    const claimPath = join(
      runsDirectory,
      ".requests",
      `q-${base64Url(run.requestId)}`,
      "claim.json",
    );
    const claim = JSON.parse(await Deno.readTextFile(claimPath)) as Record<
      string,
      unknown
    >;
    claim.requestSha256 = artifact.sha256;
    await Deno.writeTextFile(claimPath, `${canonicalJson(claim)}\n`);
  }
  await Deno.writeTextFile(ledgerPath, `${canonicalJson(ledger)}\n`);
}

async function rewriteAttestedText(
  runsDirectory: string,
  run: RecordedStaticRun,
  name: "mesh.geo" | "mesh.inp" | "job.inp" | "job.dat",
  mutate: (text: string) => string,
): Promise<void> {
  const artifactPath = join(runsDirectory, run.runId, name);
  const text = mutate(await Deno.readTextFile(artifactPath));
  const bytes = new TextEncoder().encode(text);
  await Deno.writeTextFile(artifactPath, text);
  const ledgerPath = join(runsDirectory, run.runId, "ledger.json");
  const ledger = JSON.parse(await Deno.readTextFile(ledgerPath)) as {
    artifacts: Array<{ name: string; bytes: number; sha256: string }>;
  };
  const artifact = ledger.artifacts.find((candidate) =>
    candidate.name === name
  );
  assert(artifact);
  artifact.bytes = bytes.length;
  artifact.sha256 = sha256Hex(bytes);
  await Deno.writeTextFile(ledgerPath, `${canonicalJson(ledger)}\n`);
}

async function duplicateRunDirectory(
  runsDirectory: string,
  run: RecordedStaticRun,
): Promise<void> {
  const duplicateId = `r-${crypto.randomUUID()}`;
  const destination = join(runsDirectory, duplicateId);
  await Deno.mkdir(destination);
  for (const artifact of RECORDED_ARTIFACTS) {
    await Deno.copyFile(
      join(runsDirectory, run.runId, artifact),
      join(destination, artifact),
    );
  }
  const ledger = JSON.parse(
    await Deno.readTextFile(join(runsDirectory, run.runId, "ledger.json")),
  ) as {
    runId: string;
    inputArtifact: { uri: string };
    artifacts: Array<{
      name: string;
      uri: string;
      bytes: number;
      sha256: string;
    }>;
  };
  ledger.runId = duplicateId;
  ledger.inputArtifact.uri = `casys://calculix/runs/${duplicateId}/input.step`;
  for (const artifact of ledger.artifacts) {
    artifact.uri = `casys://calculix/runs/${duplicateId}/${artifact.name}`;
  }
  const resultPath = join(destination, "result.json");
  const result = JSON.parse(await Deno.readTextFile(resultPath)) as {
    inputArtifact: { uri: string };
  };
  result.inputArtifact.uri = `casys://calculix/runs/${duplicateId}/input.step`;
  const resultText = `${canonicalJson(result)}\n`;
  await Deno.writeTextFile(resultPath, resultText);
  const resultArtifact = ledger.artifacts.find((artifact) =>
    artifact.name === "result.json"
  );
  assert(resultArtifact);
  const resultBytes = new TextEncoder().encode(resultText);
  resultArtifact.bytes = resultBytes.length;
  resultArtifact.sha256 = sha256Hex(resultBytes);
  await Deno.writeTextFile(
    join(destination, "ledger.json"),
    `${canonicalJson(ledger)}\n`,
  );
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function waitForPaths(paths: readonly string[]): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (paths.every((path) => exists(path))) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${paths.join(", ")}`);
}

function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function base64Url(value: string): string {
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/u,
    "",
  );
}

const PROTOCOL_VERSION = "2026-07-28";
const META = {
  "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "runs-test", version: "1" },
};

async function rpc(
  url: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ result: Record<string, unknown> }> {
  const body = await rpcRaw(url, method, params);
  if (!("result" in body)) {
    throw new Error(`Expected JSON-RPC result: ${JSON.stringify(body)}`);
  }
  return body;
}

async function rpcRaw(
  url: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<
  | { result: Record<string, unknown> }
  | { error: Record<string, unknown> }
> {
  const name = method === "resources/read"
    ? params.uri
    : method === "tools/call"
    ? params.name
    : undefined;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": PROTOCOL_VERSION,
      "mcp-method": method,
      ...(typeof name === "string" ? { "mcp-name": name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: { ...params, _meta: META },
    }),
  });
  assertEquals(response.status, 200);
  const body = await response.json() as {
    result?: Record<string, unknown>;
    error?: Record<string, unknown>;
  };
  if (body.result) return { result: body.result };
  if (body.error) return { error: body.error };
  throw new Error("Expected JSON-RPC result or error.");
}

async function subscribeToResourceChanges(url: string): Promise<{
  events: string[];
  close: () => Promise<void>;
}> {
  const abort = new AbortController();
  const response = await fetch(url, {
    method: "POST",
    signal: abort.signal,
    headers: {
      "content-type": "application/json",
      "accept": "text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
      "mcp-method": "subscriptions/listen",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "calculix-resource-changes",
      method: "subscriptions/listen",
      params: {
        notifications: { resourcesListChanged: true },
        _meta: META,
      },
    }),
  });
  assertEquals(response.status, 200);
  if (!response.body) throw new Error("Resource subscription has no body.");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const events: string[] = [];
  let buffered = "";
  let pumpFailure: unknown;
  const pump = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += value;
        const frames = buffered.split("\n\n");
        buffered = frames.pop() ?? "";
        events.push(...frames.filter((frame) => frame.length > 0));
      }
    } catch (error) {
      if (!abort.signal.aborted) pumpFailure = error;
    }
  })();
  return {
    events,
    close: async () => {
      abort.abort();
      await reader.cancel().catch(() => {});
      await pump;
      if (pumpFailure !== undefined) throw pumpFailure;
    },
  };
}

async function waitUntil(
  predicate: () => boolean,
  description: string,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function resourceChangeCount(events: readonly string[]): number {
  return events.filter((frame) =>
    frame.includes("notifications/resources/list_changed")
  ).length;
}

async function assertResourceChangeCountStays(
  events: readonly string[],
  expected: number,
): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 75));
  assertEquals(resourceChangeCount(events), expected);
}

function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}
