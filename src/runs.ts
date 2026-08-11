/**
 * Durable request claims and content-attested evidence for recorded CalculiX
 * static solves.
 *
 * A request directory is the cross-process lock. Its claim is committed and
 * synced before Gmsh or CalculiX may start. Once a request identity exists it
 * is never silently dispatched again: completed retries return the same run,
 * while dispatched/quarantined/evicted retries report an unknown or unavailable
 * outcome.
 */

import { join } from "@std/path";
import { createHash } from "node:crypto";
import { buildDeck, parseDat, type SolveResult } from "./api/ccx.ts";
import { buildGeoScript, inspectInp } from "./api/gmsh.ts";

export const RECORDED_STATIC_RUN_SCHEMA_VERSION = "2.0";
export const RECORDED_REQUEST_STATE_SCHEMA_VERSION = "2.0";
export const DEFAULT_MAX_RECORDED_RUNS = 24;
export const DEFAULT_RUNS_DIRECTORY = "state/runs";

const REQUESTS_DIRECTORY = ".requests";
const STAGING_DIRECTORY = ".staging";
const CLAIM_CANDIDATE_PREFIX = ".claim-candidate-";
const CLAIM_PUBLICATION_LOCK_FILE = ".publication.lock";
const WRITER_LOCK_FILE = ".writer.lock";
const CLAIM_FILE = "claim.json";
const SEALED_REQUEST_FILE = "sealed-request.json";
const LEDGER_FILE = "ledger.json";
const RUN_ID_PATTERN =
  /^r-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export const RECORDED_ARTIFACTS = [
  "input.step",
  "request.json",
  "mesh.geo",
  "mesh.inp",
  "gmsh.log",
  "job.inp",
  "ccx.log",
  "job.dat",
  "result.json",
] as const;

export type RecordedArtifactName = typeof RECORDED_ARTIFACTS[number];
export type RecordedRequestState =
  | "dispatched"
  | "completed"
  | "quarantined"
  | "evicted";

const MIME_TYPES: Record<RecordedArtifactName, string> = {
  "input.step": "model/step",
  "request.json": "application/json",
  "mesh.geo": "text/plain",
  "mesh.inp": "text/plain",
  "gmsh.log": "text/plain",
  "job.inp": "text/plain",
  "ccx.log": "text/plain",
  "job.dat": "text/plain",
  "result.json": "application/json",
};

export interface RecordedArtifact {
  name: RecordedArtifactName;
  uri: string;
  mimeType: string;
  bytes: number;
  sha256: string;
}

export interface InputArtifactAttestation {
  uri: string;
  mimeType: "model/step";
  sha256: string;
  bytes: number;
}

export interface RecordedStaticRun {
  schemaVersion: typeof RECORDED_STATIC_RUN_SCHEMA_VERSION;
  state: "completed";
  runId: string;
  requestId: string;
  requestSha256: string;
  inputArtifact: InputArtifactAttestation;
  createdAt: string;
  artifacts: readonly RecordedArtifact[];
}

export interface RecordedRequestClaim {
  schemaVersion: typeof RECORDED_REQUEST_STATE_SCHEMA_VERSION;
  state: RecordedRequestState;
  requestId: string;
  /**
   * Immutable digest used for the pre-execution ownership election.  Recorded
   * handlers derive it from only pure, normalized caller input.
   */
  requestSha256: string;
  /**
   * Digest of the exact effective request, including the observed engine
   * identity. It is durable before snapshotting and native execution begins.
   */
  sealedRequestSha256: string | null;
  runId: string;
  createdAt: string;
  updatedAt: string;
  reason: string | null;
}

interface LegacyRequestOrphan {
  requestId: string;
  reason: string;
}

export type RequestClaimResult =
  | { outcome: "claimed"; claim: RecordedRequestClaim }
  | { outcome: "completed"; run: RecordedStaticRun };

export interface RecordedStaticRunPayload {
  requestJson: string;
  inputArtifact: Omit<InputArtifactAttestation, "uri" | "mimeType">;
  inputStep: Uint8Array;
  meshGeo: string;
  meshInp: string;
  gmshDiagnostics: string;
  jobInp: string;
  ccxDiagnostics: string;
  jobDat: string;
  resultJson: string;
}

/** Pure, run-independent validation result for a recorded static request. */
export interface ValidatedRecordedStaticRequest {
  value: Record<string, unknown>;
  requestId: string;
  stepPath: string;
  expectedStepSha256: string;
  meshSizeMm: number;
  elementOrder: 1 | 2;
  material: { e_mpa: number; nu: number };
  selections: Array<{
    name: string;
    box: {
      min: [number, number, number];
      max: [number, number, number];
    };
  }>;
  fixed: string[];
  loads: Array<{
    selection: string;
    force_n: [number, number, number];
  }>;
  timeoutMs: number;
  executionIdentity: RecordedStaticExecutionIdentity;
}

/** Identity of the exact lowering and binaries admitted before native work. */
export interface RecordedStaticExecutionIdentity {
  schema_version: "1.0";
  server: { package: "@casys/mcp-calculix"; version: string };
  method: { id: "calculix_solve_static_recorded"; version: "1.0" };
  lowering: { id: "calculix.static.abaqus-deck"; version: "1.0" };
  engines: {
    gmsh: { command: "gmsh"; version: string };
    ccx: { command: "ccx"; version: string };
  };
  /** No OCI digest is claimed unless the host can actually attest one. */
  image: { status: "unattested" };
}

export type RecordedRunLookup =
  | {
    schemaVersion: "1.0";
    status: "completed";
    lookup: { kind: "run_id" | "request_id"; value: string };
    requestId: string;
    runId: string;
    run: RecordedStaticRun;
  }
  | {
    schemaVersion: "1.0";
    status: "dispatched" | "quarantined" | "evicted";
    lookup: { kind: "run_id" | "request_id"; value: string };
    requestId: string;
    runId: string;
    reason: string | null;
  }
  | {
    schemaVersion: "1.0";
    status: "not_found";
    lookup: { kind: "run_id" | "request_id"; value: string };
  }
  | {
    schemaVersion: "1.0";
    status: "outcome_unknown";
    lookup: { kind: "request_id"; value: string };
    requestId: string;
    reason: string;
  };

export interface CalculixRunStoreOptions {
  runsDirectory?: string;
  maxRuns?: number;
  onRecord?: (run: RecordedStaticRun) => void;
  onEvict?: (run: RecordedStaticRun) => void;
  /** Test-only crash seam after the final run directory becomes durable. */
  afterLedgerCommit?: (run: RecordedStaticRun) => void;
  /** Test-only pause after a complete claim candidate is durable. */
  beforeClaimPublication?: (
    candidateDirectory: string,
    requestDirectory: string,
  ) => void | Promise<void>;
}

export interface CalculixRunLifecycleCallbacks {
  onRecord?: (run: RecordedStaticRun) => void;
  onEvict?: (run: RecordedStaticRun) => void;
}

export class CalculixRunIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalculixRunIntegrityError";
  }
}

export class CalculixRunOutcomeUnknownError extends CalculixRunIntegrityError {
  readonly state: Exclude<RecordedRequestState, "completed">;

  constructor(
    requestId: string,
    state: Exclude<RecordedRequestState, "completed">,
    reason?: string | null,
  ) {
    super(
      state === "dispatched"
        ? `request_id '${requestId}' is already dispatched; its outcome is unknown and it will not be redispatched.`
        : `request_id '${requestId}' is ${state} and will not be redispatched${
          reason ? `: ${reason}` : "."
        }`,
    );
    this.name = "CalculixRunOutcomeUnknownError";
    this.state = state;
  }
}

/** A bounded durable registry of recorded static runs and request tombstones. */
export class CalculixRunStore {
  readonly runsDirectory: string;
  readonly maxRuns: number;
  private readonly requestsDirectory: string;
  private readonly stagingDirectory: string;
  private readonly claimPublicationLockPath: string;
  private readonly writerLockPath: string;
  private readonly runs = new Map<string, RecordedStaticRun>();
  private readonly runsByRequestId = new Map<string, RecordedStaticRun>();
  private readonly claimsByRequestId = new Map<string, RecordedRequestClaim>();
  private readonly legacyOrphansByRequestId = new Map<
    string,
    LegacyRequestOrphan
  >();
  private completionTail: Promise<void> = Promise.resolve();
  private onRecord?: (run: RecordedStaticRun) => void;
  private onEvict?: (run: RecordedStaticRun) => void;
  private readonly afterLedgerCommit?: (run: RecordedStaticRun) => void;
  private readonly beforeClaimPublication?:
    CalculixRunStoreOptions["beforeClaimPublication"];

  constructor(options: CalculixRunStoreOptions = {}) {
    this.runsDirectory = options.runsDirectory ?? DEFAULT_RUNS_DIRECTORY;
    this.maxRuns = options.maxRuns ?? DEFAULT_MAX_RECORDED_RUNS;
    if (!Number.isSafeInteger(this.maxRuns) || this.maxRuns < 1) {
      throw new TypeError("maxRuns must be a positive safe integer.");
    }
    this.requestsDirectory = join(this.runsDirectory, REQUESTS_DIRECTORY);
    this.stagingDirectory = join(this.runsDirectory, STAGING_DIRECTORY);
    this.claimPublicationLockPath = join(
      this.requestsDirectory,
      CLAIM_PUBLICATION_LOCK_FILE,
    );
    this.writerLockPath = join(this.runsDirectory, WRITER_LOCK_FILE);
    this.onRecord = options.onRecord;
    this.onEvict = options.onEvict;
    this.afterLedgerCommit = options.afterLedgerCommit;
    this.beforeClaimPublication = options.beforeClaimPublication;
    this.initializeDirectories();
    this.cleanupClaimCandidatesIfNoPublisherSync();
    const maintained = tryWithExclusiveFileLockSync(
      this.writerLockPath,
      () => {
        this.cleanupStagingSync();
        this.loadPersistedState();
        this.enforceBoundSync();
      },
    );
    if (!maintained) this.loadPersistedState();
  }

  setOnRecord(onRecord: ((run: RecordedStaticRun) => void) | undefined): void {
    this.onRecord = onRecord;
  }

  setLifecycleCallbacks(callbacks: CalculixRunLifecycleCallbacks): void {
    this.onRecord = callbacks.onRecord;
    this.onEvict = callbacks.onEvict;
  }

  /** Retry a best-effort MCP resource projection after durable completion. */
  republish(run: RecordedStaticRun): void {
    if (this.runs.get(run.runId) !== run) return;
    try {
      this.onRecord?.(run);
    } catch {
      // Resource projection is downstream of the durable ledger.
    }
  }

  list(): readonly RecordedStaticRun[] {
    return [...this.runs.values()].sort(compareRunsNewestFirst);
  }

  get(runId: string): RecordedStaticRun | undefined {
    const existing = this.runs.get(runId);
    if (existing) return existing;
    validateRunId(runId);
    try {
      const run = readAndVerifyRunDirectory(this.runsDirectory, runId);
      const claim = this.readClaimRequiredSync(run.requestId);
      if (claim.state !== "completed") {
        throw new CalculixRunOutcomeUnknownError(
          claim.requestId,
          claim.state,
          claim.reason,
        );
      }
      assertRunMatchesClaim(run, claim);
      this.addCompletedRun(run);
      return run;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined;
      if (
        error instanceof CalculixRunIntegrityError &&
        error.message.includes("has no readable ledger") &&
        !existsSync(this.runDirectory(runId))
      ) return undefined;
      throw error;
    }
  }

  getRequestClaim(requestId: string): RecordedRequestClaim | undefined {
    validateRequestId(requestId);
    return this.readClaimIfPresentSync(requestId);
  }

  /** Resolve a request identity from durable state without accepting a digest. */
  getByRequestId(requestId: string): RecordedStaticRun | undefined {
    validateRequestId(requestId);
    const claim = this.readClaimIfPresentSync(requestId);
    if (!claim) {
      const orphan = this.readLegacyOrphanIfPresentSync(requestId);
      if (!orphan) return undefined;
      throw legacyOrphanError(orphan);
    }
    if (claim.state === "completed") return this.recoverCompletedRun(claim);
    if (claim.state === "dispatched") {
      const reconciled = this.reconcileDispatchedClaim(claim);
      if (reconciled) return reconciled;
    }
    throw new CalculixRunOutcomeUnknownError(
      requestId,
      claim.state,
      claim.reason,
    );
  }

  /**
   * Closed, message-free recovery classification for `calculix_run_get`.
   * A state never authorizes redispatch; callers receive no fabricated run.
   */
  lookupRun(
    lookup: { kind: "run_id" | "request_id"; value: string },
  ): RecordedRunLookup {
    if (lookup.kind === "request_id") {
      validateRequestId(lookup.value);
      const claim = this.readClaimIfPresentSync(lookup.value);
      if (!claim) {
        const orphan = this.readLegacyOrphanIfPresentSync(lookup.value);
        if (orphan) {
          return legacyOrphanLookup(
            { kind: "request_id", value: lookup.value },
            orphan,
          );
        }
        return { schemaVersion: "1.0", status: "not_found", lookup };
      }
      if (claim.state === "dispatched") {
        const reconciled = this.reconcileDispatchedClaim(claim);
        if (reconciled) {
          return {
            schemaVersion: "1.0",
            status: "completed",
            lookup,
            requestId: reconciled.requestId,
            runId: reconciled.runId,
            run: reconciled,
          };
        }
      }
      const current = this.readClaimRequiredSync(lookup.value);
      if (current.state === "completed") {
        const run = this.recoverCompletedRun(current);
        return {
          schemaVersion: "1.0",
          status: "completed",
          lookup,
          requestId: run.requestId,
          runId: run.runId,
          run,
        };
      }
      return unavailableLookup(lookup, current);
    }
    validateRunId(lookup.value);
    const claim = this.findClaimByRunIdSync(lookup.value);
    if (!claim) return { schemaVersion: "1.0", status: "not_found", lookup };
    if (claim.state === "dispatched") {
      const reconciled = this.reconcileDispatchedClaim(claim);
      if (reconciled) {
        return {
          schemaVersion: "1.0",
          status: "completed",
          lookup,
          requestId: reconciled.requestId,
          runId: reconciled.runId,
          run: reconciled,
        };
      }
    }
    const current = this.readClaimRequiredSync(claim.requestId);
    if (current.state === "completed") {
      const run = this.recoverCompletedRun(current);
      return {
        schemaVersion: "1.0",
        status: "completed",
        lookup,
        requestId: run.requestId,
        runId: run.runId,
        run,
      };
    }
    return unavailableLookup(lookup, current);
  }

  /**
   * Claim a canonical request before any native subprocess starts.
   *
   * `mkdir(request-directory)` is the atomic cross-process winner election.
   * A loser only reads the durable state and can never become a second owner.
   */
  async claimRequest(
    requestId: string,
    requestJson: string,
  ): Promise<RequestClaimResult> {
    return await this.createClaim(requestId, requestJson, requestJson);
  }

  /**
   * Elect an owner from a pure normalized request before probing the host.
   * The winner must call `sealClaim` before it may snapshot or execute.
   */
  async claimPreflightRequest(
    requestId: string,
    requestJson: string,
  ): Promise<RequestClaimResult> {
    return await this.createClaim(requestId, requestJson, null);
  }

  /**
   * Durably bind the winning preflight claim to the effective request after
   * engine identity has been observed. This is deliberately a one-way step.
   */
  async sealClaim(
    claim: RecordedRequestClaim,
    requestJson: string,
  ): Promise<RecordedRequestClaim> {
    assertCanonicalJsonText(requestJson, "sealed recorded request");
    const current = this.readClaimRequiredSync(claim.requestId);
    assertSameClaim(current, claim);
    if (current.state !== "dispatched") {
      throw new CalculixRunOutcomeUnknownError(
        current.requestId,
        current.state as Exclude<RecordedRequestState, "completed">,
        current.reason,
      );
    }
    const requestBytes = new TextEncoder().encode(requestJson);
    const sealedRequestSha256 = sha256Hex(requestBytes);
    if (current.sealedRequestSha256 !== null) {
      if (current.sealedRequestSha256 === sealedRequestSha256) return current;
      throw new CalculixRunIntegrityError(
        `request_id '${current.requestId}' is already sealed to a different canonical request digest.`,
      );
    }
    await writeAtomicBytes(
      this.sealedRequestPath(current.requestId),
      requestBytes,
    );
    const readback = await Deno.readFile(
      this.sealedRequestPath(current.requestId),
    );
    if (
      readback.length !== requestBytes.length ||
      !readback.every((byte, index) => byte === requestBytes[index])
    ) {
      throw new CalculixRunIntegrityError(
        "Durable sealed request readback does not match the effective request.",
      );
    }
    const sealed: RecordedRequestClaim = {
      ...current,
      sealedRequestSha256,
      updatedAt: new Date().toISOString(),
    };
    await writeAtomicJson(this.claimPath(current.requestId), sealed);
    this.claimsByRequestId.set(current.requestId, sealed);
    return sealed;
  }

  private async createClaim(
    requestId: string,
    requestJson: string,
    sealedRequestJson: string | null,
  ): Promise<RequestClaimResult> {
    validateRequestId(requestId);
    assertCanonicalJsonText(requestJson, "recorded request");
    const requestSha256 = sha256Hex(new TextEncoder().encode(requestJson));
    const directory = this.requestDirectory(requestId);
    let winner: RecordedRequestClaim | undefined;
    await withExclusiveFileLock(this.claimPublicationLockPath, async () => {
      this.cleanupClaimCandidatesSync();
      if (existsSync(directory)) return;
      const now = new Date().toISOString();
      const sealedRequestSha256 = sealedRequestJson === null
        ? null
        : sha256Hex(new TextEncoder().encode(sealedRequestJson));
      const claim: RecordedRequestClaim = {
        schemaVersion: RECORDED_REQUEST_STATE_SCHEMA_VERSION,
        state: "dispatched",
        requestId,
        requestSha256,
        sealedRequestSha256,
        runId: `r-${crypto.randomUUID()}`,
        createdAt: now,
        updatedAt: now,
        reason: null,
      };
      const candidate = join(
        this.requestsDirectory,
        `${CLAIM_CANDIDATE_PREFIX}${crypto.randomUUID()}`,
      );
      await Deno.mkdir(candidate, { mode: 0o700 });
      let published = false;
      try {
        if (sealedRequestJson !== null) {
          await writeAtomicBytes(
            join(candidate, SEALED_REQUEST_FILE),
            new TextEncoder().encode(sealedRequestJson),
          );
        }
        await writeAtomicJson(join(candidate, CLAIM_FILE), claim);
        await syncDirectory(candidate);
        await this.beforeClaimPublication?.(candidate, directory);
        try {
          await Deno.rename(candidate, directory);
          published = true;
          winner = claim;
        } catch (error) {
          // A non-cooperating older process may have published while this
          // process held the new publication lock. Never replace its marker.
          if (existsSync(directory)) return;
          throw error;
        }
        try {
          await syncDirectory(this.requestsDirectory);
        } catch (error) {
          throw new CalculixRunOutcomeUnknownError(
            requestId,
            "dispatched",
            `atomic claim parent sync failed: ${message(error)}`,
          );
        }
      } catch (error) {
        if (published) throw error;
        throw new CalculixRunIntegrityError(
          `Unable to prepare atomic request claim: ${message(error)}`,
        );
      } finally {
        await Deno.remove(candidate, { recursive: true }).catch(() => {});
      }
    });

    if (winner) {
      this.claimsByRequestId.set(requestId, winner);
      return { outcome: "claimed", claim: winner };
    }

    const claim = await this.readClaimAfterContendedCreate(requestId);
    assertRequestDigest(claim, requestSha256);
    if (claim.state === "completed") {
      return { outcome: "completed", run: this.recoverCompletedRun(claim) };
    }
    if (claim.state === "dispatched") {
      const reconciled = this.reconcileDispatchedClaim(claim);
      if (reconciled) return { outcome: "completed", run: reconciled };
    }
    throw new CalculixRunOutcomeUnknownError(
      requestId,
      claim.state,
      claim.reason,
    );
  }

  findByRequest(
    requestId: string,
    requestJson: string,
  ): RecordedStaticRun | undefined {
    validateRequestId(requestId);
    assertCanonicalJsonText(requestJson, "recorded request");
    const claim = this.readClaimIfPresentSync(requestId);
    if (!claim) {
      const orphan = this.readLegacyOrphanIfPresentSync(requestId);
      if (!orphan) return undefined;
      throw legacyOrphanError(orphan);
    }
    assertRequestDigest(
      claim,
      sha256Hex(new TextEncoder().encode(requestJson)),
    );
    if (claim.state === "completed") return this.recoverCompletedRun(claim);
    if (claim.state === "dispatched") {
      const reconciled = this.reconcileDispatchedClaim(claim);
      if (reconciled) return reconciled;
    }
    throw new CalculixRunOutcomeUnknownError(
      requestId,
      claim.state,
      claim.reason,
    );
  }

  /** Mark a known pre-completion failure without making the identity reusable. */
  async quarantineClaim(
    claim: RecordedRequestClaim,
    reason: string,
  ): Promise<void> {
    const current = this.readClaimRequiredSync(claim.requestId);
    assertSameClaim(current, claim);
    if (current.state !== "dispatched") {
      return;
    }
    const quarantined: RecordedRequestClaim = {
      ...current,
      state: "quarantined",
      updatedAt: new Date().toISOString(),
      reason: canonicalReason(reason),
    };
    await writeAtomicJson(this.claimPath(claim.requestId), quarantined);
    this.claimsByRequestId.set(claim.requestId, quarantined);
  }

  /**
   * Commit a completed run for a previously durable dispatched claim.
   * Artifacts and ledger are built under a private staging directory, fully
   * synced, then the complete directory is atomically renamed into place.
   */
  async completeClaim(
    claim: RecordedRequestClaim,
    payload: RecordedStaticRunPayload,
  ): Promise<RecordedStaticRun> {
    return await this.withCompletionLock(async () => {
      const current = this.readClaimRequiredSync(claim.requestId);
      assertSameClaim(current, claim);
      if (current.state === "completed") {
        return this.recoverCompletedRun(current);
      }
      if (current.state !== "dispatched") {
        throw new CalculixRunOutcomeUnknownError(
          current.requestId,
          current.state,
          current.reason,
        );
      }
      assertCanonicalJsonText(payload.requestJson, "recorded request");
      const requestBytes = new TextEncoder().encode(payload.requestJson);
      const requestSha256 = sha256Hex(requestBytes);
      await this.assertSealedRequest(current, payload.requestJson);
      const inputStep = Uint8Array.from(payload.inputStep);
      if (inputStep.length < 1) {
        throw new CalculixRunIntegrityError(
          "Recorded input.step must not be empty.",
        );
      }
      const inputSha256 = sha256Hex(inputStep);
      if (
        payload.inputArtifact.bytes !== inputStep.length ||
        payload.inputArtifact.sha256 !== inputSha256
      ) {
        throw new CalculixRunIntegrityError(
          "Recorded input.step bytes do not match their supplied attestation.",
        );
      }
      assertCanonicalJsonText(payload.resultJson, "recorded normalized result");

      const staging = join(
        this.stagingDirectory,
        `${current.runId}.${crypto.randomUUID()}`,
      );
      const finalDirectory = this.runDirectory(current.runId);
      await Deno.mkdir(staging, { mode: 0o700 });
      let committed = false;
      try {
        const contents: Record<RecordedArtifactName, Uint8Array> = {
          "input.step": inputStep,
          "request.json": requestBytes,
          "mesh.geo": new TextEncoder().encode(payload.meshGeo),
          "mesh.inp": new TextEncoder().encode(payload.meshInp),
          "gmsh.log": new TextEncoder().encode(payload.gmshDiagnostics),
          "job.inp": new TextEncoder().encode(payload.jobInp),
          "ccx.log": new TextEncoder().encode(payload.ccxDiagnostics),
          "job.dat": new TextEncoder().encode(payload.jobDat),
          "result.json": new TextEncoder().encode(payload.resultJson),
        };
        const artifacts: RecordedArtifact[] = [];
        for (const name of RECORDED_ARTIFACTS) {
          const bytes = contents[name];
          await writeDurableBytes(join(staging, name), bytes);
          artifacts.push({
            name,
            uri: artifactUri(current.runId, name),
            mimeType: MIME_TYPES[name],
            bytes: bytes.length,
            sha256: sha256Hex(bytes),
          });
        }
        await syncDirectory(staging);
        const inputArtifact: InputArtifactAttestation = {
          uri: artifactUri(current.runId, "input.step"),
          mimeType: "model/step",
          sha256: inputSha256,
          bytes: inputStep.length,
        };
        const run: RecordedStaticRun = {
          schemaVersion: RECORDED_STATIC_RUN_SCHEMA_VERSION,
          state: "completed",
          runId: current.runId,
          requestId: current.requestId,
          requestSha256,
          inputArtifact,
          createdAt: this.nextRunTimestamp(),
          artifacts,
        };
        const request = parseRecordedStaticRequest(payload.requestJson, run);
        const normalizedResult = parseRecordedStaticResult(
          payload.resultJson,
          run,
        );
        assertRecordedResultMatchesRequest(normalizedResult, request);
        assertRecordedRunCausality({
          run,
          request,
          result: normalizedResult,
          meshGeo: payload.meshGeo,
          meshInp: payload.meshInp,
          jobInp: payload.jobInp,
          jobDat: payload.jobDat,
        });
        await writeAtomicJson(join(staging, LEDGER_FILE), run);
        await syncDirectory(staging);
        await Deno.rename(staging, finalDirectory);
        await syncDirectory(this.runsDirectory);
        committed = true;

        // This seam models a crash after the durable ledger wins but before the
        // request index can be advanced. Startup recovery may promote it only
        // after proving a single exact matching ledger.
        this.afterLedgerCommit?.(run);

        const completedClaim: RecordedRequestClaim = {
          ...current,
          state: "completed",
          updatedAt: new Date().toISOString(),
          reason: null,
        };
        await writeAtomicJson(
          this.claimPath(current.requestId),
          completedClaim,
        );
        this.claimsByRequestId.set(current.requestId, completedClaim);
        this.addCompletedRun(run);
        await this.enforceBound();
        if (!this.runs.has(run.runId)) {
          const evicted = this.readClaimRequiredSync(run.requestId);
          throw new CalculixRunOutcomeUnknownError(
            evicted.requestId,
            evicted.state as Exclude<RecordedRequestState, "completed">,
            evicted.reason,
          );
        }
        if (this.runs.has(run.runId)) this.republish(run);
        return run;
      } catch (error) {
        if (!committed) {
          await Deno.remove(staging, { recursive: true }).catch(() => {});
          await this.quarantineClaim(
            current,
            `completion failed: ${message(error)}`,
          ).catch(() => {});
        }
        throw error;
      }
    });
  }

  /** Read one issued resource, rechecking bytes and SHA-256 every time. */
  readArtifact(uri: string):
    | { uri: string; mimeType: string; blob: string }
    | { uri: string; mimeType: string; text: string } {
    return this.readArtifactSync(uri);
  }

  readArtifactSync(uri: string):
    | { uri: string; mimeType: string; blob: string }
    | { uri: string; mimeType: string; text: string } {
    const lookup = parseArtifactUri(uri);
    if (!lookup) throw new CalculixRunIntegrityError("Resource not found.");
    const run = this.runs.get(lookup.runId);
    const artifact = run?.artifacts.find((item) => item.name === lookup.name);
    if (!run || !artifact || artifact.uri !== uri) {
      throw new CalculixRunIntegrityError("Resource not found.");
    }
    const bytes = readVerifiedArtifactBytes(this.runsDirectory, run, artifact);
    if (artifact.name === "input.step") {
      return { uri, mimeType: artifact.mimeType, blob: encodeBase64(bytes) };
    }
    return {
      uri,
      mimeType: artifact.mimeType,
      text: decodeCanonicalUtf8(bytes, artifact.uri),
    };
  }

  readNormalizedResult(runId: string): Record<string, unknown> {
    const run = this.get(runId);
    if (!run) throw new CalculixRunIntegrityError("Recorded run not found.");
    const artifact = run.artifacts.find((item) => item.name === "result.json");
    if (!artifact) {
      throw new CalculixRunIntegrityError("Recorded result is unavailable.");
    }
    const resultContent = this.readArtifactSync(artifact.uri);
    if (!("text" in resultContent)) {
      throw new CalculixRunIntegrityError("Recorded result is not text JSON.");
    }
    const requestArtifact = run.artifacts.find((item) =>
      item.name === "request.json"
    );
    if (!requestArtifact) {
      throw new CalculixRunIntegrityError("Recorded request is unavailable.");
    }
    const requestContent = this.readArtifactSync(requestArtifact.uri);
    if (!("text" in requestContent)) {
      throw new CalculixRunIntegrityError("Recorded request is not text JSON.");
    }
    const request = parseRecordedStaticRequest(requestContent.text, run);
    const result = parseRecordedStaticResult(resultContent.text, run);
    assertRecordedResultMatchesRequest(result, request);
    return result;
  }

  private initializeDirectories(): void {
    try {
      Deno.mkdirSync(this.runsDirectory, { recursive: true, mode: 0o700 });
      Deno.mkdirSync(this.requestsDirectory, { recursive: true, mode: 0o700 });
      Deno.mkdirSync(this.stagingDirectory, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new CalculixRunIntegrityError(
        `Unable to initialize CalculiX runs directory '${this.runsDirectory}': ${
          message(error)
        }`,
      );
    }
  }

  private loadPersistedState(): void {
    const claims = this.loadClaims();
    const claimsByRunId = new Map(
      [...claims.values()].map((claim) => [claim.runId, claim]),
    );
    const ledgers: RecordedStaticRun[] = [];
    for (const entry of Deno.readDirSync(this.runsDirectory)) {
      if (!entry.isDirectory || !RUN_ID_PATTERN.test(entry.name)) continue;
      const claim = claimsByRunId.get(entry.name);
      if (claim?.state === "quarantined" || claim?.state === "evicted") {
        this.cleanupUnavailableRunSync(entry.name);
        continue;
      }
      ledgers.push(readAndVerifyRunDirectory(this.runsDirectory, entry.name));
    }

    const byRequest = new Map<string, RecordedStaticRun[]>();
    for (const run of ledgers) {
      const group = byRequest.get(run.requestId) ?? [];
      group.push(run);
      byRequest.set(run.requestId, group);
    }
    for (const [requestId, runs] of byRequest) {
      if (runs.length !== 1) {
        throw new CalculixRunIntegrityError(
          `Duplicate durable ledgers exist for request_id '${requestId}'.`,
        );
      }
    }

    for (const run of ledgers) {
      const claim = claims.get(run.requestId);
      if (!claim) {
        throw new CalculixRunIntegrityError(
          `Recorded run '${run.runId}' has no durable request claim.`,
        );
      }
      assertRunMatchesClaim(run, claim);
      if (claim.state === "dispatched") {
        const recovered: RecordedRequestClaim = {
          ...claim,
          state: "completed",
          updatedAt: new Date().toISOString(),
          reason: null,
        };
        writeAtomicJsonSync(this.claimPath(claim.requestId), recovered);
        claims.set(claim.requestId, recovered);
        this.claimsByRequestId.set(claim.requestId, recovered);
      }
      this.addCompletedRun(run);
    }

    for (const claim of claims.values()) {
      if (claim.state === "completed" && !byRequest.has(claim.requestId)) {
        throw new CalculixRunIntegrityError(
          `Completed request_id '${claim.requestId}' has no unique durable ledger.`,
        );
      }
    }
  }

  private loadClaims(): Map<string, RecordedRequestClaim> {
    const claims = new Map<string, RecordedRequestClaim>();
    const claimedRunIds = new Set<string>();
    for (const entry of Deno.readDirSync(this.requestsDirectory)) {
      if (!entry.isDirectory) continue;
      if (entry.name.startsWith(CLAIM_CANDIDATE_PREFIX)) continue;
      if (!entry.name.startsWith("q-")) {
        throw new CalculixRunIntegrityError(
          `Unexpected request-state directory '${entry.name}'.`,
        );
      }
      const path = join(this.requestsDirectory, entry.name, CLAIM_FILE);
      let claim: RecordedRequestClaim;
      try {
        claim = parseClaim(Deno.readTextFileSync(path));
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          this.recordLegacyOrphanFromDirectoryName(entry.name);
          continue;
        }
        throw new CalculixRunIntegrityError(
          `Invalid durable request claim '${entry.name}': ${message(error)}`,
        );
      }
      if (entry.name !== requestDirectoryName(claim.requestId)) {
        throw new CalculixRunIntegrityError(
          "Request claim directory does not match request_id.",
        );
      }
      if (claims.has(claim.requestId)) {
        throw new CalculixRunIntegrityError(
          `Duplicate durable claims exist for request_id '${claim.requestId}'.`,
        );
      }
      if (claimedRunIds.has(claim.runId)) {
        throw new CalculixRunIntegrityError(
          `Duplicate durable claims bind run_id '${claim.runId}'.`,
        );
      }
      claims.set(claim.requestId, claim);
      claimedRunIds.add(claim.runId);
      this.claimsByRequestId.set(claim.requestId, claim);
    }
    return claims;
  }

  private recoverCompletedRun(claim: RecordedRequestClaim): RecordedStaticRun {
    const existing = this.runs.get(claim.runId);
    if (existing) {
      assertRunMatchesClaim(existing, claim);
      return existing;
    }
    if (claim.state !== "completed") {
      throw new CalculixRunOutcomeUnknownError(
        claim.requestId,
        claim.state,
        claim.reason,
      );
    }
    const run = readAndVerifyRunDirectory(this.runsDirectory, claim.runId);
    assertRunMatchesClaim(run, claim);
    const duplicate = this.runsByRequestId.get(run.requestId);
    if (duplicate && duplicate.runId !== run.runId) {
      throw new CalculixRunIntegrityError(
        `Duplicate durable ledgers exist for request_id '${run.requestId}'.`,
      );
    }
    this.addCompletedRun(run);
    return run;
  }

  /**
   * Reconcile the narrow crash window after a durable run-directory rename but
   * before the claim advances to completed. No ledger means outcome unknown;
   * more than one or any mismatch is a fail-closed integrity error.
   */
  private reconcileDispatchedClaim(
    claim: RecordedRequestClaim,
  ): RecordedStaticRun | undefined {
    if (claim.state !== "dispatched") return undefined;
    const candidates: RecordedStaticRun[] = [];
    for (const entry of Deno.readDirSync(this.runsDirectory)) {
      if (!entry.isDirectory || !RUN_ID_PATTERN.test(entry.name)) continue;
      const run = readAndVerifyRunDirectory(this.runsDirectory, entry.name);
      if (run.requestId === claim.requestId) candidates.push(run);
    }
    if (candidates.length === 0) return undefined;
    if (candidates.length !== 1) {
      throw new CalculixRunIntegrityError(
        `Duplicate durable ledgers exist for request_id '${claim.requestId}'.`,
      );
    }
    const run = candidates[0];
    assertRunMatchesClaim(run, claim);
    const completed: RecordedRequestClaim = {
      ...claim,
      state: "completed",
      updatedAt: new Date().toISOString(),
      reason: null,
    };
    writeAtomicJsonSync(this.claimPath(claim.requestId), completed);
    this.claimsByRequestId.set(claim.requestId, completed);
    this.addCompletedRun(run);
    this.enforceBoundSync();
    if (!this.runs.has(run.runId)) {
      const evicted = this.readClaimRequiredSync(run.requestId);
      if (evicted.state !== "evicted") {
        throw new CalculixRunIntegrityError(
          "Reconciled run disappeared without an evicted tombstone.",
        );
      }
      throw new CalculixRunOutcomeUnknownError(
        evicted.requestId,
        evicted.state,
        evicted.reason,
      );
    }
    return run;
  }

  private addCompletedRun(run: RecordedStaticRun): void {
    this.runs.set(run.runId, run);
    this.runsByRequestId.set(run.requestId, run);
  }

  private nextRunTimestamp(): string {
    const newest = this.list()[0];
    const minimum = newest === undefined ? 0 : Date.parse(newest.createdAt) + 1;
    return new Date(Math.max(Date.now(), minimum)).toISOString();
  }

  private async readClaimAfterContendedCreate(
    requestId: string,
  ): Promise<RecordedRequestClaim> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const claim = this.readClaimIfPresentSync(requestId);
      if (claim) return claim;
      const orphan = this.readLegacyOrphanIfPresentSync(requestId);
      if (orphan) throw legacyOrphanError(orphan);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new CalculixRunOutcomeUnknownError(
      requestId,
      "dispatched",
      "the winning process did not finish its durable claim",
    );
  }

  private readClaimIfPresentSync(
    requestId: string,
  ): RecordedRequestClaim | undefined {
    try {
      const claim = parseClaim(
        Deno.readTextFileSync(this.claimPath(requestId)),
      );
      if (claim.requestId !== requestId) {
        throw new CalculixRunIntegrityError("Request claim identity mismatch.");
      }
      this.legacyOrphansByRequestId.delete(claim.requestId);
      this.claimsByRequestId.set(claim.requestId, claim);
      return claim;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    }
  }

  private readClaimRequiredSync(requestId: string): RecordedRequestClaim {
    const claim = this.readClaimIfPresentSync(requestId);
    if (!claim) {
      throw new CalculixRunIntegrityError(
        `No durable claim exists for request_id '${requestId}'.`,
      );
    }
    return claim;
  }

  private readLegacyOrphanIfPresentSync(
    requestId: string,
  ): LegacyRequestOrphan | undefined {
    const existing = this.legacyOrphansByRequestId.get(requestId);
    if (existing) return existing;
    const directory = this.requestDirectory(requestId);
    if (!existsSync(directory) || existsSync(join(directory, CLAIM_FILE))) {
      return undefined;
    }
    return this.recordLegacyOrphanFromDirectoryName(
      requestDirectoryName(requestId),
    );
  }

  private recordLegacyOrphanFromDirectoryName(
    directoryName: string,
  ): LegacyRequestOrphan {
    const requestId = requestIdFromDirectoryName(directoryName);
    const orphan: LegacyRequestOrphan = {
      requestId,
      reason:
        "legacy request owner directory exists without a durable claim; outcome is unknown and redispatch is forbidden",
    };
    this.legacyOrphansByRequestId.set(requestId, orphan);
    return orphan;
  }

  private findClaimByRunIdSync(
    runId: string,
  ): RecordedRequestClaim | undefined {
    for (const entry of Deno.readDirSync(this.requestsDirectory)) {
      if (!entry.isDirectory || !entry.name.startsWith("q-")) continue;
      let claim: RecordedRequestClaim;
      try {
        claim = parseClaim(Deno.readTextFileSync(join(
          this.requestsDirectory,
          entry.name,
          CLAIM_FILE,
        )));
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) continue;
        throw error;
      }
      if (entry.name !== requestDirectoryName(claim.requestId)) {
        throw new CalculixRunIntegrityError(
          "Request claim directory does not match request_id.",
        );
      }
      if (claim.runId === runId) return claim;
    }
    return undefined;
  }

  private async withCompletionLock<T>(operation: () => Promise<T>): Promise<T> {
    let release: () => void = () => {};
    const previous = this.completionTail;
    this.completionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await withExclusiveFileLock(this.writerLockPath, async () => {
        // The kernel lock proves that no live completion owner can still be
        // using any directory left under .staging.
        this.cleanupStagingSync();
        return await operation();
      });
    } finally {
      release();
    }
  }

  private cleanupClaimCandidatesIfNoPublisherSync(): void {
    tryWithExclusiveFileLockSync(
      this.claimPublicationLockPath,
      () => this.cleanupClaimCandidatesSync(),
    );
  }

  private cleanupClaimCandidatesSync(): void {
    let removed = false;
    for (const entry of Deno.readDirSync(this.requestsDirectory)) {
      if (!entry.name.startsWith(CLAIM_CANDIDATE_PREFIX)) continue;
      Deno.removeSync(join(this.requestsDirectory, entry.name), {
        recursive: true,
      });
      removed = true;
    }
    if (removed) syncDirectorySync(this.requestsDirectory);
  }

  private cleanupStagingSync(): void {
    let removed = false;
    for (const entry of Deno.readDirSync(this.stagingDirectory)) {
      Deno.removeSync(join(this.stagingDirectory, entry.name), {
        recursive: true,
      });
      removed = true;
    }
    if (removed) syncDirectorySync(this.stagingDirectory);
  }

  private async enforceBound(): Promise<void> {
    for (const run of this.list().slice(this.maxRuns)) await this.evictRun(run);
  }

  private enforceBoundSync(): void {
    for (const run of this.list().slice(this.maxRuns)) this.evictRunSync(run);
  }

  private async evictRun(run: RecordedStaticRun): Promise<void> {
    const claim = this.readClaimRequiredSync(run.requestId);
    assertRunMatchesClaim(run, claim);
    const tombstone = evictedClaim(claim);
    await writeAtomicJson(this.claimPath(run.requestId), tombstone);
    this.claimsByRequestId.set(run.requestId, tombstone);
    this.runs.delete(run.runId);
    this.runsByRequestId.delete(run.requestId);
    try {
      this.onEvict?.(run);
    } catch {
      // Durable eviction won; resource lifecycle can be retried on restart.
    }
    await Deno.remove(this.runDirectory(run.runId), { recursive: true }).catch(
      () => {},
    );
    await syncDirectory(this.runsDirectory);
  }

  private evictRunSync(run: RecordedStaticRun): void {
    const claim = this.readClaimRequiredSync(run.requestId);
    assertRunMatchesClaim(run, claim);
    const tombstone = evictedClaim(claim);
    writeAtomicJsonSync(this.claimPath(run.requestId), tombstone);
    this.claimsByRequestId.set(run.requestId, tombstone);
    this.runs.delete(run.runId);
    this.runsByRequestId.delete(run.requestId);
    try {
      this.onEvict?.(run);
    } catch {
      // Durable eviction won.
    }
    try {
      Deno.removeSync(this.runDirectory(run.runId), { recursive: true });
      syncDirectorySync(this.runsDirectory);
    } catch {
      // The durable tombstone prevents replay even if physical cleanup lags.
    }
  }

  private cleanupUnavailableRunSync(runId: string): void {
    try {
      Deno.removeSync(this.runDirectory(runId), { recursive: true });
      syncDirectorySync(this.runsDirectory);
    } catch {
      // It remains inaccessible because its durable state is not completed.
    }
  }

  private requestDirectory(requestId: string): string {
    validateRequestId(requestId);
    return join(this.requestsDirectory, requestDirectoryName(requestId));
  }

  private claimPath(requestId: string): string {
    return join(this.requestDirectory(requestId), CLAIM_FILE);
  }

  private sealedRequestPath(requestId: string): string {
    return join(this.requestDirectory(requestId), SEALED_REQUEST_FILE);
  }

  private async assertSealedRequest(
    claim: RecordedRequestClaim,
    requestJson: string,
  ): Promise<void> {
    if (claim.sealedRequestSha256 === null) {
      throw new CalculixRunIntegrityError(
        "Recorded request claim has not sealed an effective request.",
      );
    }
    const bytes = new TextEncoder().encode(requestJson);
    if (sha256Hex(bytes) !== claim.sealedRequestSha256) {
      throw new CalculixRunIntegrityError(
        "Recorded request does not match its sealed claim digest.",
      );
    }
    let sealedBytes: Uint8Array;
    try {
      sealedBytes = await Deno.readFile(
        this.sealedRequestPath(claim.requestId),
      );
    } catch (error) {
      throw new CalculixRunIntegrityError(
        `Recorded sealed request is unavailable: ${message(error)}`,
      );
    }
    let sealedText: string;
    try {
      sealedText = new TextDecoder("utf-8", { fatal: true }).decode(
        sealedBytes,
      );
      assertCanonicalJsonText(sealedText, "recorded sealed request");
    } catch (error) {
      throw new CalculixRunIntegrityError(
        `Recorded sealed request is invalid: ${message(error)}`,
      );
    }
    if (
      sha256Hex(sealedBytes) !== claim.sealedRequestSha256 ||
      sealedText !== requestJson
    ) {
      throw new CalculixRunIntegrityError(
        "Recorded sealed request does not exactly match its effective request.",
      );
    }
  }

  private runDirectory(runId: string): string {
    validateRunId(runId);
    return join(this.runsDirectory, runId);
  }
}

export function artifactUri(runId: string, name: RecordedArtifactName): string {
  validateRunId(runId);
  if (!RECORDED_ARTIFACTS.includes(name)) {
    throw new CalculixRunIntegrityError("Invalid recorded artifact identity.");
  }
  return `casys://calculix/runs/${runId}/${name}`;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("Recorded JSON cannot contain non-finite numbers.");
  }
  return value;
}

function parseClaim(text: string): RecordedRequestClaim {
  const candidate = parseCanonicalJsonText(
    text,
    "durable request claim",
  ) as Record<
    string,
    unknown
  >;
  assertExactKeys(candidate, [
    "createdAt",
    "reason",
    "requestId",
    "requestSha256",
    "runId",
    "sealedRequestSha256",
    "schemaVersion",
    "state",
    "updatedAt",
  ], "durable request claim");
  if (candidate.schemaVersion !== RECORDED_REQUEST_STATE_SCHEMA_VERSION) {
    throw new CalculixRunIntegrityError(
      "Unsupported durable request claim schema.",
    );
  }
  const state = candidate.state;
  if (
    state !== "dispatched" && state !== "completed" &&
    state !== "quarantined" && state !== "evicted"
  ) {
    throw new CalculixRunIntegrityError("Invalid durable request state.");
  }
  if (
    typeof candidate.reason === "string" &&
    candidate.reason !== canonicalReason(candidate.reason)
  ) {
    throw new CalculixRunIntegrityError(
      "Durable request reason is not canonical.",
    );
  }
  if (typeof candidate.requestId !== "string") {
    throw new CalculixRunIntegrityError("Invalid durable request_id.");
  }
  validateRequestId(candidate.requestId);
  if (
    typeof candidate.requestSha256 !== "string" ||
    !DIGEST_PATTERN.test(candidate.requestSha256)
  ) {
    throw new CalculixRunIntegrityError("Invalid durable request digest.");
  }
  if (
    candidate.sealedRequestSha256 !== null &&
    (typeof candidate.sealedRequestSha256 !== "string" ||
      !DIGEST_PATTERN.test(candidate.sealedRequestSha256))
  ) {
    throw new CalculixRunIntegrityError(
      "Invalid durable sealed request digest.",
    );
  }
  if (typeof candidate.runId !== "string") {
    throw new CalculixRunIntegrityError("Invalid run id.");
  }
  validateRunId(candidate.runId);
  const createdAt = canonicalTimestamp(candidate.createdAt, "createdAt");
  const updatedAt = canonicalTimestamp(candidate.updatedAt, "updatedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new CalculixRunIntegrityError(
      "Durable request updatedAt precedes createdAt.",
    );
  }
  if (
    ((state === "quarantined" || state === "evicted") &&
      (typeof candidate.reason !== "string" || !candidate.reason)) ||
    (state !== "quarantined" && state !== "evicted" &&
      candidate.reason !== null) ||
    (state === "completed" && candidate.sealedRequestSha256 === null)
  ) {
    throw new CalculixRunIntegrityError(
      "Durable request reason disagrees with its state.",
    );
  }
  return {
    schemaVersion: RECORDED_REQUEST_STATE_SCHEMA_VERSION,
    state,
    requestId: candidate.requestId,
    requestSha256: candidate.requestSha256,
    sealedRequestSha256: candidate.sealedRequestSha256 as string | null,
    runId: candidate.runId,
    createdAt,
    updatedAt,
    reason: candidate.reason as string | null,
  };
}

function parseLedger(text: string): RecordedStaticRun {
  const candidate = parseCanonicalJsonText(
    text,
    "recorded run ledger",
  ) as Record<
    string,
    unknown
  >;
  assertExactKeys(candidate, [
    "artifacts",
    "createdAt",
    "inputArtifact",
    "requestId",
    "requestSha256",
    "runId",
    "schemaVersion",
    "state",
  ], "recorded run ledger");
  if (
    candidate.schemaVersion !== RECORDED_STATIC_RUN_SCHEMA_VERSION ||
    candidate.state !== "completed" ||
    typeof candidate.runId !== "string" ||
    typeof candidate.requestId !== "string" ||
    typeof candidate.requestSha256 !== "string" ||
    !Array.isArray(candidate.artifacts) ||
    candidate.artifacts.length !== RECORDED_ARTIFACTS.length
  ) throw new CalculixRunIntegrityError("Invalid recorded run ledger.");
  validateRunId(candidate.runId);
  validateRequestId(candidate.requestId);
  if (!DIGEST_PATTERN.test(candidate.requestSha256)) {
    throw new CalculixRunIntegrityError("Invalid recorded request digest.");
  }
  const runId = candidate.runId;
  const requestId = candidate.requestId;
  const requestSha256 = candidate.requestSha256;
  const inputArtifact = parseInputArtifact(
    candidate.inputArtifact,
    runId,
  );
  const artifacts = candidate.artifacts.map((artifact, index) =>
    parseArtifact(artifact, runId, RECORDED_ARTIFACTS[index])
  );
  const step = artifacts[0];
  if (
    step.name !== "input.step" || step.uri !== inputArtifact.uri ||
    step.mimeType !== inputArtifact.mimeType ||
    step.sha256 !== inputArtifact.sha256 ||
    step.bytes !== inputArtifact.bytes
  ) {
    throw new CalculixRunIntegrityError(
      "inputArtifact does not match input.step ledger entry.",
    );
  }
  return {
    schemaVersion: RECORDED_STATIC_RUN_SCHEMA_VERSION,
    state: "completed",
    runId,
    requestId,
    requestSha256,
    inputArtifact,
    createdAt: canonicalTimestamp(candidate.createdAt, "createdAt"),
    artifacts,
  };
}

function parseInputArtifact(
  value: unknown,
  runId: string,
): InputArtifactAttestation {
  const candidate = record(value, "inputArtifact");
  assertExactKeys(
    candidate,
    ["bytes", "mimeType", "sha256", "uri"],
    "inputArtifact",
  );
  if (
    candidate.uri !== artifactUri(runId, "input.step") ||
    candidate.mimeType !== "model/step" ||
    typeof candidate.sha256 !== "string" ||
    !DIGEST_PATTERN.test(candidate.sha256) ||
    !Number.isSafeInteger(candidate.bytes) || (candidate.bytes as number) < 1
  ) throw new CalculixRunIntegrityError("Invalid recorded inputArtifact.");
  return {
    uri: candidate.uri,
    mimeType: "model/step",
    sha256: candidate.sha256,
    bytes: candidate.bytes as number,
  };
}

function parseArtifact(
  value: unknown,
  runId: string,
  name: RecordedArtifactName,
): RecordedArtifact {
  const candidate = record(value, `artifact ${name}`);
  assertExactKeys(
    candidate,
    ["bytes", "mimeType", "name", "sha256", "uri"],
    `artifact ${name}`,
  );
  if (
    candidate.name !== name || candidate.uri !== artifactUri(runId, name) ||
    candidate.mimeType !== MIME_TYPES[name] ||
    typeof candidate.sha256 !== "string" ||
    !DIGEST_PATTERN.test(candidate.sha256) ||
    !Number.isSafeInteger(candidate.bytes) ||
    (candidate.bytes as number) < (name === "input.step" ? 1 : 0)
  ) {
    throw new CalculixRunIntegrityError(
      `Invalid recorded artifact ledger for ${name}.`,
    );
  }
  return {
    name,
    uri: candidate.uri,
    mimeType: candidate.mimeType,
    bytes: candidate.bytes as number,
    sha256: candidate.sha256,
  };
}

const SELECTION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,60}$/;

/**
 * Parse the exact successor request which was actually claimed. This is
 * intentionally independent from MCP wire validation: persisted evidence is
 * revalidated after restart before any resource can be published.
 */
function parseRecordedStaticRequest(
  text: string,
  run: RecordedStaticRun,
): ValidatedRecordedStaticRequest {
  const request = parseCanonicalJsonText(text, "recorded static request");
  const validated = validateRecordedStaticRequest(request);
  if (
    validated.requestId !== run.requestId ||
    validated.expectedStepSha256 !== run.inputArtifact.sha256
  ) {
    throw new CalculixRunIntegrityError(
      "Recorded static request does not bind its request_id and exact STEP digest to the run ledger.",
    );
  }
  return validated;
}

/**
 * Validate every run-independent field before an identity can be claimed or a
 * native process can start. Replay calls the same validator, then adds the
 * run-dependent request/input bindings above.
 */
export function validateRecordedStaticRequest(
  request: Record<string, unknown>,
): ValidatedRecordedStaticRequest {
  assertRequiredAllowedKeys(
    request,
    [
      "execution_identity",
      "element_order",
      "expected_step_sha256",
      "fixed",
      "loads",
      "material",
      "mesh_size_mm",
      "request_id",
      "selections",
      "step_path",
      "timeout_ms",
    ],
    [],
    "recorded static request",
  );
  if (
    typeof request.request_id !== "string" ||
    typeof request.expected_step_sha256 !== "string"
  ) {
    throw new CalculixRunIntegrityError(
      "Recorded static request requires string request_id and expected_step_sha256.",
    );
  }
  validateRequestId(request.request_id);
  if (!DIGEST_PATTERN.test(request.expected_step_sha256)) {
    throw new CalculixRunIntegrityError(
      "Recorded static request expected_step_sha256 must be lowercase hexadecimal SHA-256.",
    );
  }
  if (
    typeof request.step_path !== "string" || request.step_path.length < 1 ||
    request.step_path.includes("\0")
  ) {
    throw new CalculixRunIntegrityError(
      "Recorded static request has an invalid step_path.",
    );
  }
  const meshSizeMm = assertFiniteNumber(request.mesh_size_mm, "mesh_size_mm", {
    exclusiveMinimum: 0,
  });
  if (request.element_order !== 1 && request.element_order !== 2) {
    throw new CalculixRunIntegrityError(
      "Recorded static request has an invalid element_order.",
    );
  }
  assertPositiveSafeInteger(request.timeout_ms, "timeout_ms");
  const executionIdentity = parseRecordedStaticExecutionIdentity(
    request.execution_identity,
  );

  const material = record(request.material, "recorded material");
  assertExactKeys(material, ["e_mpa", "nu"], "recorded material");
  const eMpa = assertFiniteNumber(material.e_mpa, "material.e_mpa", {
    exclusiveMinimum: 0,
  });
  const nu = assertFiniteNumber(material.nu, "material.nu", {
    exclusiveMinimum: 0,
    exclusiveMaximum: 0.5,
  });

  if (!Array.isArray(request.selections) || request.selections.length < 1) {
    throw new CalculixRunIntegrityError(
      "Recorded static request selections must be a non-empty array.",
    );
  }
  const knownSelections = new Set<string>();
  for (const [index, value] of request.selections.entries()) {
    const selection = record(value, `recorded selection ${index}`);
    assertExactKeys(
      selection,
      ["box", "name"],
      `recorded selection ${index}`,
    );
    if (
      typeof selection.name !== "string" ||
      !SELECTION_NAME_PATTERN.test(selection.name) ||
      knownSelections.has(selection.name)
    ) {
      throw new CalculixRunIntegrityError(
        `Recorded selection ${index} has an invalid or duplicate name.`,
      );
    }
    knownSelections.add(selection.name);
    const box = record(selection.box, `recorded selection ${index} box`);
    assertExactKeys(box, ["max", "min"], `recorded selection ${index} box`);
    const min = finiteVector3(box.min, `recorded selection ${index} box.min`);
    const max = finiteVector3(box.max, `recorded selection ${index} box.max`);
    if (min.some((coordinate, axis) => coordinate >= max[axis])) {
      throw new CalculixRunIntegrityError(
        `Recorded selection ${index} box must have min strictly below max on every axis.`,
      );
    }
  }

  const fixed = selectionNameArray(request.fixed, "recorded fixed selections");
  if (new Set(fixed).size !== fixed.length) {
    throw new CalculixRunIntegrityError(
      "Recorded fixed selections contain duplicates.",
    );
  }
  if (!Array.isArray(request.loads) || request.loads.length < 1) {
    throw new CalculixRunIntegrityError(
      "Recorded static request loads must be a non-empty array.",
    );
  }
  const loadedSelections: string[] = [];
  for (const [index, value] of request.loads.entries()) {
    const load = record(value, `recorded load ${index}`);
    assertExactKeys(
      load,
      ["force_n", "selection"],
      `recorded load ${index}`,
    );
    if (
      typeof load.selection !== "string" ||
      !SELECTION_NAME_PATTERN.test(load.selection)
    ) {
      throw new CalculixRunIntegrityError(
        `Recorded load ${index} has an invalid selection.`,
      );
    }
    loadedSelections.push(load.selection);
    finiteVector3(load.force_n, `recorded load ${index} force_n`);
  }
  for (const name of [...fixed, ...loadedSelections]) {
    if (!knownSelections.has(name)) {
      throw new CalculixRunIntegrityError(
        `Recorded constraint '${name}' is not declared in selections.`,
      );
    }
  }
  const overlap = fixed.filter((name) => loadedSelections.includes(name));
  if (overlap.length > 0) {
    throw new CalculixRunIntegrityError(
      "Recorded static request fixes and loads the same selection.",
    );
  }
  return {
    value: request,
    requestId: request.request_id,
    stepPath: request.step_path,
    expectedStepSha256: request.expected_step_sha256,
    meshSizeMm,
    elementOrder: request.element_order as 1 | 2,
    material: { e_mpa: eMpa, nu },
    selections: request
      .selections as ValidatedRecordedStaticRequest["selections"],
    fixed,
    loads: request.loads as ValidatedRecordedStaticRequest["loads"],
    timeoutMs: request.timeout_ms as number,
    executionIdentity,
  };
}

/**
 * Build the sealed successor request.  Wire defaults are materialized before
 * claim creation, so a later default change cannot reinterpret a run.
 */
export function resolveRecordedStaticRequest(
  input: Record<string, unknown>,
  executionIdentity: RecordedStaticExecutionIdentity,
): ValidatedRecordedStaticRequest {
  const expectedStepSha256 = typeof input.expected_step_sha256 === "string"
    ? input.expected_step_sha256.toLowerCase()
    : input.expected_step_sha256;
  const withDefaults = {
    ...input,
    expected_step_sha256: expectedStepSha256,
    element_order: input.element_order ?? 2,
    timeout_ms: input.timeout_ms ?? 120_000,
    execution_identity: executionIdentity,
  };
  return validateRecordedStaticRequest(withDefaults);
}

export function parseRecordedStaticExecutionIdentity(
  value: unknown,
): RecordedStaticExecutionIdentity {
  const identity = record(value, "recorded execution_identity");
  assertExactKeys(
    identity,
    ["engines", "image", "lowering", "method", "schema_version", "server"],
    "recorded execution_identity",
  );
  if (identity.schema_version !== "1.0") {
    throw new CalculixRunIntegrityError(
      "Unsupported recorded execution identity schema.",
    );
  }
  const server = record(identity.server, "recorded execution server");
  assertExactKeys(server, ["package", "version"], "recorded execution server");
  if (
    server.package !== "@casys/mcp-calculix" ||
    typeof server.version !== "string" || !isVersionToken(server.version)
  ) {
    throw new CalculixRunIntegrityError(
      "Recorded execution server identity is invalid.",
    );
  }
  const method = record(identity.method, "recorded execution method");
  assertExactKeys(method, ["id", "version"], "recorded execution method");
  if (
    method.id !== "calculix_solve_static_recorded" || method.version !== "1.0"
  ) {
    throw new CalculixRunIntegrityError(
      "Recorded execution method identity is invalid.",
    );
  }
  const lowering = record(identity.lowering, "recorded execution lowering");
  assertExactKeys(lowering, ["id", "version"], "recorded execution lowering");
  if (
    lowering.id !== "calculix.static.abaqus-deck" || lowering.version !== "1.0"
  ) {
    throw new CalculixRunIntegrityError(
      "Recorded execution lowering identity is invalid.",
    );
  }
  const engines = record(identity.engines, "recorded execution engines");
  assertExactKeys(engines, ["ccx", "gmsh"], "recorded execution engines");
  const gmsh = parseRecordedEngineIdentity(engines.gmsh, "gmsh") as {
    command: "gmsh";
    version: string;
  };
  const ccx = parseRecordedEngineIdentity(engines.ccx, "ccx") as {
    command: "ccx";
    version: string;
  };
  const image = record(identity.image, "recorded execution image");
  assertExactKeys(image, ["status"], "recorded execution image");
  if (image.status !== "unattested") {
    throw new CalculixRunIntegrityError(
      "Recorded execution image may only claim the explicit unattested state.",
    );
  }
  return {
    schema_version: "1.0",
    server: { package: "@casys/mcp-calculix", version: server.version },
    method: { id: "calculix_solve_static_recorded", version: "1.0" },
    lowering: { id: "calculix.static.abaqus-deck", version: "1.0" },
    engines: { gmsh, ccx },
    image: { status: "unattested" },
  };
}

function parseRecordedEngineIdentity(
  value: unknown,
  command: "gmsh" | "ccx",
): { command: typeof command; version: string } {
  const engine = record(value, `recorded ${command} engine`);
  assertExactKeys(engine, ["command", "version"], `recorded ${command} engine`);
  if (
    engine.command !== command || typeof engine.version !== "string" ||
    !isVersionToken(engine.version)
  ) {
    throw new CalculixRunIntegrityError(
      `Recorded ${command} engine identity is invalid.`,
    );
  }
  return { command, version: engine.version };
}

function isVersionToken(value: string): boolean {
  return value.length >= 1 && value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._+ -]*$/.test(value);
}

/** Strict semantic parser shared by startup verification and run_get replay. */
function parseRecordedStaticResult(
  text: string,
  run: RecordedStaticRun,
): Record<string, unknown> {
  const result = parseCanonicalJsonText(text, "recorded normalized result");
  assertExactKeys(result, [
    "constraints",
    "inputArtifact",
    "kind",
    "mesh",
    "metrics",
    "schemaVersion",
  ], "recorded normalized result");
  if (
    result.schemaVersion !== RECORDED_STATIC_RUN_SCHEMA_VERSION ||
    result.kind !== "static-solve-recorded"
  ) {
    throw new CalculixRunIntegrityError(
      "Recorded normalized result has an unsupported identity.",
    );
  }

  const inputArtifact = record(
    result.inputArtifact,
    "recorded result inputArtifact",
  );
  assertExactKeys(
    inputArtifact,
    ["bytes", "mimeType", "sha256", "uri"],
    "recorded result inputArtifact",
  );
  if (
    inputArtifact.uri !== run.inputArtifact.uri ||
    inputArtifact.mimeType !== run.inputArtifact.mimeType ||
    inputArtifact.sha256 !== run.inputArtifact.sha256 ||
    inputArtifact.bytes !== run.inputArtifact.bytes
  ) {
    throw new CalculixRunIntegrityError(
      "Recorded normalized result inputArtifact does not exactly match the run STEP identity.",
    );
  }

  const mesh = record(result.mesh, "recorded result mesh");
  assertExactKeys(
    mesh,
    ["elements", "nodes", "nodesPerSelection"],
    "recorded result mesh",
  );
  assertPositiveSafeInteger(mesh.nodes, "mesh.nodes");
  assertPositiveSafeInteger(mesh.elements, "mesh.elements");
  const nodesPerSelection = record(
    mesh.nodesPerSelection,
    "mesh.nodesPerSelection",
  );
  if (Object.keys(nodesPerSelection).length < 1) {
    throw new CalculixRunIntegrityError(
      "Recorded mesh has no attested selection counts.",
    );
  }
  for (const [name, count] of Object.entries(nodesPerSelection)) {
    if (!SELECTION_NAME_PATTERN.test(name)) {
      throw new CalculixRunIntegrityError(
        `Recorded mesh contains an invalid selection name '${name}'.`,
      );
    }
    assertPositiveSafeInteger(count, `mesh.nodesPerSelection.${name}`);
  }

  const constraints = record(result.constraints, "recorded result constraints");
  assertExactKeys(
    constraints,
    ["fixedSelections", "loads"],
    "recorded result constraints",
  );
  const fixed = selectionNameArray(
    constraints.fixedSelections,
    "recorded result fixedSelections",
  );
  if (!Array.isArray(constraints.loads) || constraints.loads.length < 1) {
    throw new CalculixRunIntegrityError(
      "Recorded result loads must be a non-empty array.",
    );
  }
  const loaded: string[] = [];
  for (const [index, value] of constraints.loads.entries()) {
    const load = record(value, `recorded result load ${index}`);
    assertExactKeys(
      load,
      ["forceN", "selection"],
      `recorded result load ${index}`,
    );
    if (
      typeof load.selection !== "string" ||
      !SELECTION_NAME_PATTERN.test(load.selection)
    ) {
      throw new CalculixRunIntegrityError(
        `Recorded result load ${index} has an invalid selection.`,
      );
    }
    loaded.push(load.selection);
    finiteVector3(load.forceN, `recorded result load ${index} forceN`);
  }
  for (const name of [...fixed, ...loaded]) {
    if (!(name in nodesPerSelection)) {
      throw new CalculixRunIntegrityError(
        `Recorded result constraint '${name}' has no positive mesh selection count.`,
      );
    }
  }
  if (fixed.some((name) => loaded.includes(name))) {
    throw new CalculixRunIntegrityError(
      "Recorded result fixes and loads the same selection.",
    );
  }

  const metrics = record(result.metrics, "recorded result metrics");
  assertExactKeys(
    metrics,
    ["maxDisplacement", "maxVonMises"],
    "recorded result metrics",
  );
  const displacement = record(
    metrics.maxDisplacement,
    "recorded maxDisplacement",
  );
  assertExactKeys(
    displacement,
    ["nodeId", "unit", "value", "vectorMm"],
    "recorded maxDisplacement",
  );
  if (displacement.unit !== "mm") {
    throw new CalculixRunIntegrityError(
      "Recorded maxDisplacement unit must be mm.",
    );
  }
  const displacementValue = assertFiniteNumber(
    displacement.value,
    "maxDisplacement.value",
    { minimum: 0 },
  );
  assertPositiveSafeInteger(displacement.nodeId, "maxDisplacement.nodeId");
  const vector = finiteVector3(
    displacement.vectorMm,
    "maxDisplacement.vectorMm",
  );
  const vectorMagnitude = Math.hypot(...vector);
  const magnitudeTolerance = 8 * Number.EPSILON *
    Math.max(1, displacementValue, vectorMagnitude);
  if (Math.abs(displacementValue - vectorMagnitude) > magnitudeTolerance) {
    throw new CalculixRunIntegrityError(
      "Recorded maxDisplacement value disagrees with vectorMm.",
    );
  }

  const vonMises = record(metrics.maxVonMises, "recorded maxVonMises");
  assertExactKeys(
    vonMises,
    ["elementId", "unit", "value"],
    "recorded maxVonMises",
  );
  if (vonMises.unit !== "MPa") {
    throw new CalculixRunIntegrityError(
      "Recorded maxVonMises unit must be MPa.",
    );
  }
  assertFiniteNumber(vonMises.value, "maxVonMises.value", { minimum: 0 });
  assertPositiveSafeInteger(vonMises.elementId, "maxVonMises.elementId");
  return result;
}

function assertRecordedResultMatchesRequest(
  result: Record<string, unknown>,
  request: ValidatedRecordedStaticRequest,
): void {
  const constraints = record(result.constraints, "recorded result constraints");
  const expected = {
    fixedSelections: request.fixed,
    loads: request.loads.map((load) => ({
      selection: load.selection,
      forceN: load.force_n,
    })),
  };
  if (canonicalJson(constraints) !== canonicalJson(expected)) {
    throw new CalculixRunIntegrityError(
      "Recorded normalized constraints do not exactly match the claimed request.",
    );
  }
  const mesh = record(result.mesh, "recorded result mesh");
  const nodesPerSelection = record(
    mesh.nodesPerSelection,
    "mesh.nodesPerSelection",
  );
  for (const selection of request.selections) {
    if (!Object.hasOwn(nodesPerSelection, selection.name)) {
      throw new CalculixRunIntegrityError(
        `Recorded mesh omits requested selection '${selection.name}'.`,
      );
    }
  }
}

/**
 * Reconstruct every native boundary from persisted bytes.  This deliberately
 * does not trust a precomputed mesh/result object: the mesh is parsed again,
 * the deck is lowered again, and the normalized observations are parsed again
 * from the exact CalculiX .dat artifact.
 */
function assertRecordedRunCausality(args: {
  run: RecordedStaticRun;
  request: ValidatedRecordedStaticRequest;
  result: Record<string, unknown>;
  meshGeo: string;
  meshInp: string;
  jobInp: string;
  jobDat: string;
}): void {
  const expectedGeo = buildGeoScript({
    stepPath: "input.step",
    selections: args.request.selections,
    meshSizeMm: args.request.meshSizeMm,
    elementOrder: args.request.elementOrder,
    timeoutMs: args.request.timeoutMs,
  });
  if (args.meshGeo !== expectedGeo) {
    throw new CalculixRunIntegrityError(
      "Recorded mesh.geo is not the deterministic stable lowering of the resolved request.",
    );
  }
  const inspection = inspectInp(args.meshInp);
  const mesh = record(args.result.mesh, "recorded result mesh");
  const resultCounts = record(mesh.nodesPerSelection, "mesh.nodesPerSelection");
  if (
    mesh.nodes !== inspection.nodeCount ||
    mesh.elements !== inspection.elementCount ||
    canonicalJson(resultCounts) !== canonicalJson(inspection.nodesPerSet)
  ) {
    throw new CalculixRunIntegrityError(
      "Recorded normalized mesh counts do not match exact mesh.inp inspection.",
    );
  }
  const expectedDeck = buildDeck({
    inpText: args.meshInp,
    maxNodeId: inspection.maxNodeId,
    material: {
      eMpa: args.request.material.e_mpa,
      nu: args.request.material.nu,
    },
    fixed: args.request.fixed,
    loads: args.request.loads.map((load) => ({
      selection: load.selection,
      totalForceN: load.force_n,
    })),
    nodesPerSet: inspection.nodesPerSet,
  });
  if (args.jobInp !== expectedDeck) {
    throw new CalculixRunIntegrityError(
      "Recorded job.inp is not the deterministic deck lowering of mesh.inp and the resolved request.",
    );
  }
  let parsed: SolveResult;
  try {
    parsed = parseDat(args.jobDat);
  } catch (error) {
    throw new CalculixRunIntegrityError(
      `Recorded job.dat cannot reproduce normalized result metrics: ${
        message(error)
      }`,
    );
  }
  const metrics = record(args.result.metrics, "recorded result metrics");
  const displacement = record(
    metrics.maxDisplacement,
    "recorded maxDisplacement",
  );
  const vonMises = record(metrics.maxVonMises, "recorded maxVonMises");
  if (
    displacement.value !== parsed.maxDisplacement.magnitudeMm ||
    displacement.nodeId !== parsed.maxDisplacement.nodeId ||
    canonicalJson(displacement.vectorMm) !==
      canonicalJson(parsed.maxDisplacement.vectorMm) ||
    vonMises.value !== parsed.maxVonMises.mpa ||
    vonMises.elementId !== parsed.maxVonMises.elementId
  ) {
    throw new CalculixRunIntegrityError(
      "Recorded result.json metrics are not derived exactly from recorded job.dat.",
    );
  }
}

function selectionNameArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length < 1) {
    throw new CalculixRunIntegrityError(`${name} must be a non-empty array.`);
  }
  const selections: string[] = [];
  for (const selection of value) {
    if (
      typeof selection !== "string" ||
      !SELECTION_NAME_PATTERN.test(selection)
    ) {
      throw new CalculixRunIntegrityError(`${name} contains an invalid name.`);
    }
    selections.push(selection);
  }
  return selections;
}

function finiteVector3(value: unknown, name: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new CalculixRunIntegrityError(`${name} must contain three numbers.`);
  }
  return [
    assertFiniteNumber(value[0], `${name}[0]`),
    assertFiniteNumber(value[1], `${name}[1]`),
    assertFiniteNumber(value[2], `${name}[2]`),
  ];
}

function assertFiniteNumber(
  value: unknown,
  name: string,
  bounds: {
    minimum?: number;
    exclusiveMinimum?: number;
    exclusiveMaximum?: number;
  } = {},
): number {
  if (
    typeof value !== "number" || !Number.isFinite(value) ||
    (bounds.minimum !== undefined && value < bounds.minimum) ||
    (bounds.exclusiveMinimum !== undefined &&
      value <= bounds.exclusiveMinimum) ||
    (bounds.exclusiveMaximum !== undefined && value >= bounds.exclusiveMaximum)
  ) {
    throw new CalculixRunIntegrityError(`Recorded ${name} is invalid.`);
  }
  return value;
}

function assertPositiveSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new CalculixRunIntegrityError(
      `Recorded ${name} must be a positive safe integer.`,
    );
  }
  return value as number;
}

function assertRequiredAllowedKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  name: string,
): void {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new CalculixRunIntegrityError(
      `${name} has unexpected or missing fields.`,
    );
  }
}

function readAndVerifyRunDirectory(
  root: string,
  runId: string,
): RecordedStaticRun {
  validateRunId(runId);
  let ledgerText: string;
  try {
    ledgerText = Deno.readTextFileSync(join(root, runId, LEDGER_FILE));
  } catch (error) {
    throw new CalculixRunIntegrityError(
      `Recorded run '${runId}' has no readable ledger: ${message(error)}`,
    );
  }
  const run = parseLedger(ledgerText);
  if (run.runId !== runId) {
    throw new CalculixRunIntegrityError(
      "Recorded run directory and ledger identity disagree.",
    );
  }
  let request: ValidatedRecordedStaticRequest | undefined;
  let normalizedResult: Record<string, unknown> | undefined;
  const textArtifacts = new Map<RecordedArtifactName, string>();
  for (const artifact of run.artifacts) {
    const bytes = readVerifiedArtifactBytes(root, run, artifact);
    if (artifact.name !== "input.step") {
      textArtifacts.set(
        artifact.name,
        decodeCanonicalUtf8(bytes, artifact.uri),
      );
    }
    if (artifact.name === "request.json") {
      const text = textArtifacts.get(artifact.name)!;
      if (sha256Hex(bytes) !== run.requestSha256) {
        throw new CalculixRunIntegrityError(
          "request.json does not match requestSha256.",
        );
      }
      request = parseRecordedStaticRequest(text, run);
    }
    if (artifact.name === "result.json") {
      normalizedResult = parseRecordedStaticResult(
        textArtifacts.get(artifact.name)!,
        run,
      );
    }
  }
  if (!request || !normalizedResult) {
    throw new CalculixRunIntegrityError(
      "Recorded run lacks its request/result semantic evidence.",
    );
  }
  assertRecordedResultMatchesRequest(normalizedResult, request);
  assertRecordedRunCausality({
    run,
    request,
    result: normalizedResult,
    meshGeo: textArtifacts.get("mesh.geo")!,
    meshInp: textArtifacts.get("mesh.inp")!,
    jobInp: textArtifacts.get("job.inp")!,
    jobDat: textArtifacts.get("job.dat")!,
  });
  return run;
}

function readVerifiedArtifactBytes(
  root: string,
  run: RecordedStaticRun,
  artifact: RecordedArtifact,
): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = Deno.readFileSync(join(root, run.runId, artifact.name));
  } catch {
    throw new CalculixRunIntegrityError(
      `Recorded artifact is unavailable: ${artifact.uri}.`,
    );
  }
  if (bytes.length !== artifact.bytes || sha256Hex(bytes) !== artifact.sha256) {
    throw new CalculixRunIntegrityError(
      `Recorded artifact failed integrity verification: ${artifact.uri}.`,
    );
  }
  return bytes;
}

function parseArtifactUri(
  uri: string,
): { runId: string; name: RecordedArtifactName } | undefined {
  const match = /^casys:\/\/calculix\/runs\/(r-[0-9a-f-]{36})\/([a-z.]+)$/.exec(
    uri,
  );
  if (!match || !RUN_ID_PATTERN.test(match[1])) return undefined;
  const name = match[2] as RecordedArtifactName;
  return RECORDED_ARTIFACTS.includes(name)
    ? { runId: match[1], name }
    : undefined;
}

function assertRunMatchesClaim(
  run: RecordedStaticRun,
  claim: RecordedRequestClaim,
): void {
  if (
    run.runId !== claim.runId || run.requestId !== claim.requestId ||
    run.requestSha256 !== claim.sealedRequestSha256 ||
    Date.parse(run.createdAt) < Date.parse(claim.createdAt)
  ) {
    throw new CalculixRunIntegrityError(
      `Recorded run '${run.runId}' conflicts with its durable request claim.`,
    );
  }
}

function assertSameClaim(
  current: RecordedRequestClaim,
  supplied: RecordedRequestClaim,
): void {
  if (
    current.requestId !== supplied.requestId ||
    current.requestSha256 !== supplied.requestSha256 ||
    current.runId !== supplied.runId
  ) {
    throw new CalculixRunIntegrityError(
      "Durable request claim identity changed.",
    );
  }
}

function assertRequestDigest(
  claim: RecordedRequestClaim,
  requestSha256: string,
): void {
  if (claim.requestSha256 !== requestSha256) {
    throw new CalculixRunIntegrityError(
      `request_id '${claim.requestId}' is already bound to a different canonical request digest.`,
    );
  }
}

function unavailableLookup(
  lookup: { kind: "run_id" | "request_id"; value: string },
  claim: RecordedRequestClaim,
): Extract<
  RecordedRunLookup,
  { status: "dispatched" | "quarantined" | "evicted" }
> {
  if (claim.state === "completed") {
    throw new CalculixRunIntegrityError(
      "Completed claim did not resolve to a durable recorded run.",
    );
  }
  return {
    schemaVersion: "1.0",
    status: claim.state,
    lookup,
    requestId: claim.requestId,
    runId: claim.runId,
    reason: claim.reason,
  };
}

function legacyOrphanLookup(
  lookup: { kind: "request_id"; value: string },
  orphan: LegacyRequestOrphan,
): Extract<RecordedRunLookup, { status: "outcome_unknown" }> {
  return {
    schemaVersion: "1.0",
    status: "outcome_unknown",
    lookup,
    requestId: orphan.requestId,
    reason: orphan.reason,
  };
}

function legacyOrphanError(
  orphan: LegacyRequestOrphan,
): CalculixRunOutcomeUnknownError {
  return new CalculixRunOutcomeUnknownError(
    orphan.requestId,
    "quarantined",
    orphan.reason,
  );
}

function evictedClaim(claim: RecordedRequestClaim): RecordedRequestClaim {
  return {
    ...claim,
    state: "evicted",
    updatedAt: new Date().toISOString(),
    reason: "completed run evicted by the configured retention bound",
  };
}

function compareRunsNewestFirst(
  left: RecordedStaticRun,
  right: RecordedStaticRun,
): number {
  return right.createdAt.localeCompare(left.createdAt) ||
    right.runId.localeCompare(left.runId);
}

function requestDirectoryName(requestId: string): string {
  validateRequestId(requestId);
  return `q-${
    btoa(requestId).replaceAll("+", "-").replaceAll("/", "_").replace(
      /=+$/u,
      "",
    )
  }`;
}

function requestIdFromDirectoryName(directoryName: string): string {
  if (!directoryName.startsWith("q-")) {
    throw new CalculixRunIntegrityError(
      "Invalid legacy request-state directory identity.",
    );
  }
  const encoded = directoryName.slice(2).replaceAll("-", "+").replaceAll(
    "_",
    "/",
  );
  const padded = encoded + "=".repeat((4 - encoded.length % 4) % 4);
  let requestId: string;
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(
      binary,
      (character) => character.charCodeAt(0),
    );
    requestId = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CalculixRunIntegrityError(
      "Invalid legacy request-state directory identity.",
    );
  }
  validateRequestId(requestId);
  if (requestDirectoryName(requestId) !== directoryName) {
    throw new CalculixRunIntegrityError(
      "Legacy request-state directory identity is not canonical.",
    );
  }
  return requestId;
}

function validateRequestId(requestId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)) {
    throw new CalculixRunIntegrityError(
      "request_id must contain 1 to 128 letters, digits, dot, underscore, colon or hyphen and start with a letter or digit.",
    );
  }
}

function validateRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new CalculixRunIntegrityError("Invalid recorded run identity.");
  }
}

function canonicalTimestamp(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new CalculixRunIntegrityError(`Invalid ${name}.`);
  }
  try {
    if (new Date(value).toISOString() !== value) {
      throw new Error("not canonical");
    }
  } catch {
    throw new CalculixRunIntegrityError(`Invalid ${name}.`);
  }
  return value;
}

function canonicalReason(reason: string): string {
  const normalized = reason.trim().slice(0, 512);
  return normalized || "recorded execution failed before durable completion";
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CalculixRunIntegrityError(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: string[],
  name: string,
): void {
  if (
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...keys].sort())
  ) {
    throw new CalculixRunIntegrityError(
      `${name} has unexpected or missing fields.`,
    );
  }
}

function assertCanonicalJsonText(text: string, name: string): void {
  parseCanonicalJsonText(text, name);
}

function parseCanonicalJsonText(
  text: string,
  name: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CalculixRunIntegrityError(`${name} is not valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CalculixRunIntegrityError(`${name} must be a JSON object.`);
  }
  if (text !== `${canonicalJson(parsed)}\n`) {
    throw new CalculixRunIntegrityError(
      `${name} is not canonical stable JSON.`,
    );
  }
  return parsed as Record<string, unknown>;
}

function decodeCanonicalUtf8(bytes: Uint8Array, identity: string): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CalculixRunIntegrityError(
      `Recorded text artifact is not UTF-8: ${identity}.`,
    );
  }
  const encoded = new TextEncoder().encode(text);
  if (
    encoded.length !== bytes.length ||
    !bytes.every((byte, index) => byte === encoded[index])
  ) {
    throw new CalculixRunIntegrityError(
      `Recorded text artifact is not canonical UTF-8: ${identity}.`,
    );
  }
  return text;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function withExclusiveFileLock<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  const file = await Deno.open(path, {
    create: true,
    read: true,
    write: true,
    mode: 0o600,
  });
  let locked = false;
  try {
    await file.lock(true);
    locked = true;
    return await operation();
  } finally {
    if (locked) await file.unlock().catch(() => {});
    file.close();
  }
}

function tryWithExclusiveFileLockSync(
  path: string,
  operation: () => void,
): boolean {
  const file = Deno.openSync(path, {
    create: true,
    read: true,
    write: true,
    mode: 0o600,
  });
  let locked = false;
  try {
    locked = file.tryLockSync(true);
    if (!locked) return false;
    operation();
    return true;
  } finally {
    if (locked) {
      try {
        file.unlockSync();
      } catch {
        // Closing the file also releases the advisory lock.
      }
    }
    file.close();
  }
}

async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  await writeAtomicBytes(
    path,
    new TextEncoder().encode(`${canonicalJson(value)}\n`),
  );
}

function writeAtomicJsonSync(path: string, value: unknown): void {
  writeAtomicBytesSync(
    path,
    new TextEncoder().encode(`${canonicalJson(value)}\n`),
  );
}

async function writeAtomicBytes(
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeDurableBytes(temporary, bytes);
    await Deno.rename(temporary, path);
    await syncDirectory(parentPath(path));
  } finally {
    await Deno.remove(temporary).catch(() => {});
  }
}

function writeAtomicBytesSync(path: string, bytes: Uint8Array): void {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    writeDurableBytesSync(temporary, bytes);
    Deno.renameSync(temporary, path);
    syncDirectorySync(parentPath(path));
  } finally {
    try {
      Deno.removeSync(temporary);
    } catch {
      // Already renamed or never created.
    }
  }
}

async function writeDurableBytes(
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const file = await Deno.open(path, {
    write: true,
    createNew: true,
    mode: 0o600,
  });
  try {
    await writeAll(file, bytes);
    await file.syncData();
  } finally {
    file.close();
  }
}

function writeDurableBytesSync(path: string, bytes: Uint8Array): void {
  const file = Deno.openSync(path, {
    write: true,
    createNew: true,
    mode: 0o600,
  });
  try {
    writeAllSync(file, bytes);
    file.syncDataSync();
  } finally {
    file.close();
  }
}

async function writeAll(file: Deno.FsFile, bytes: Uint8Array): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const count = await file.write(bytes.subarray(written));
    if (count === 0) {
      throw new Error("writeAll made no progress");
    }
    written += count;
  }
}

function writeAllSync(file: Deno.FsFile, bytes: Uint8Array): void {
  let written = 0;
  while (written < bytes.length) {
    const count = file.writeSync(bytes.subarray(written));
    if (count === 0) {
      throw new Error("writeAllSync made no progress");
    }
    written += count;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await Deno.open(path, { read: true });
  try {
    await directory.sync();
  } finally {
    directory.close();
  }
}

function syncDirectorySync(path: string): void {
  const directory = Deno.openSync(path, { read: true });
  try {
    directory.syncSync();
  } finally {
    directory.close();
  }
}

function parentPath(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (separator < 1) {
    throw new CalculixRunIntegrityError(`Path has no durable parent: ${path}`);
  }
  return path.slice(0, separator);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function existsSync(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
