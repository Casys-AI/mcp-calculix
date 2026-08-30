/**
 * Documented I/O and cardinality budgets for CalculiX fleet execution.
 *
 * These limits are the authority for STEP snapshots, subprocess diagnostics,
 * mesh/selection cardinality, decks, and parsed solver files. Callers must
 * enforce them before allocating an untrusted declared size and while
 * streaming subprocess output. They do not change FEA physics.
 *
 * @module lib/calculix/api/budgets
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { type FileHandle, open as openNodeFile } from "node:fs/promises";

export const MAX_STEP_BYTES = 32 * 1024 * 1024;
export const MAX_DIAGNOSTICS_BYTES = 8 * 1024 * 1024;
export const MAX_MESH_INP_BYTES = 64 * 1024 * 1024;
export const MAX_JOB_DAT_BYTES = 64 * 1024 * 1024;
export const MAX_DECK_BYTES = 65 * 1024 * 1024;
export const MAX_VERSION_PROBE_BYTES = 4 * 1024;
export const MAX_MESH_NODES = 250_000;
export const MAX_MESH_ELEMENTS = 1_000_000;
export const MAX_MESH_LINES = 1_000_000;
export const MAX_NSET_NODES = 250_000;
export const MAX_NSET_ENTRIES = 1_000_000;
export const MAX_TOTAL_NSET_MEMBERSHIPS = 1_000_000;
export const MAX_SELECTIONS = 32;
export const MAX_NSET_SETS = MAX_SELECTIONS + 2;
/**
 * Maximum wall-clock budget for each external Gmsh or CalculiX invocation.
 * Ordinary and recorded static solves share this cap.
 */
export const MAX_SOLVE_TIMEOUT_MS = 120_000;

export type ResourceBudgetCode = "resource_limit" | "output_limit";
export type ResourceBudgetUnit = "bytes" | "count" | "ms";
export type ResourceBudgetName =
  | "step_bytes"
  | "selections"
  | "mesh_nodes"
  | "mesh_elements"
  | "mesh_lines"
  | "nset_nodes"
  | "nset_entries"
  | "nset_memberships"
  | "nset_sets"
  | "gmsh_diagnostics"
  | "ccx_diagnostics"
  | "mesh_inp_bytes"
  | "job_dat_bytes"
  | "deck_bytes"
  | "timeout_ms"
  | "version_probe_bytes";

export interface ResourceBudgetContext {
  resource: ResourceBudgetName;
  limit: number;
  actual: number;
  unit: ResourceBudgetUnit;
  reason?: "non_regular_file" | "file_identity_changed";
}

/**
 * Machine-readable budget failure. `code`, `context`, and `recovery` are the
 * stable fields; the message is a literal rendering of the same state. Direct
 * callers receive this Error subclass; `mapCalculixToolError` serializes the
 * same fields for MCP `isError: true` results.
 */
export class ResourceBudgetError extends Error {
  readonly code: ResourceBudgetCode;
  readonly context: ResourceBudgetContext;
  readonly recovery: string;

  constructor(args: {
    code: ResourceBudgetCode;
    context: ResourceBudgetContext;
    recovery: string;
  }) {
    super(
      `[${args.code}] ${args.context.resource} actual=${args.context.actual} ` +
        `limit=${args.context.limit}` +
        (args.context.reason ? ` reason=${args.context.reason}` : "") +
        `. ${args.recovery}`,
    );
    this.name = "ResourceBudgetError";
    this.code = args.code;
    this.context = args.context;
    this.recovery = args.recovery;
  }
}

const RECOVERY: Record<
  ResourceBudgetName,
  (limit: number) => string
> = {
  step_bytes: (limit) =>
    `Provide a smaller STEP export; the attested snapshot must be at most ${limit} bytes.`,
  selections: (limit) =>
    `Reduce named face selections to at most ${limit}. Split the request or coarsen the grouping.`,
  mesh_nodes: (limit) =>
    `Increase mesh_size_mm or simplify the geometry so the mesh has at most ${limit} nodes.`,
  mesh_elements: (limit) =>
    `Increase mesh_size_mm or simplify the geometry so the mesh has at most ${limit} volume elements.`,
  mesh_lines: (limit) =>
    `Increase mesh_size_mm or simplify the geometry so mesh.inp has at most ${limit} text lines to process.`,
  nset_nodes: (limit) =>
    `Reduce the NSET GENERATE range or named-selection box so the set has at most ${limit} node ids.`,
  nset_entries: (limit) =>
    `Reduce repeated or overlapping NSET data so parsing visits at most ${limit} raw node-id entries.`,
  nset_memberships: (limit) =>
    `Reduce or consolidate named-selection node sets so their combined memberships do not exceed ${limit}.`,
  nset_sets: (limit) =>
    `Reduce physical groups so mesh.inp contains at most ${limit} unique NSET names.`,
  gmsh_diagnostics: (limit) =>
    `Reduce mesh size, element order, or geometry complexity so Gmsh writes at most ${limit} bytes of stdout+stderr.`,
  ccx_diagnostics: (limit) =>
    `Reduce mesh size or model complexity so CalculiX writes at most ${limit} bytes of stdout+stderr.`,
  mesh_inp_bytes: (limit) =>
    `Increase mesh_size_mm or simplify the geometry so the cleaned mesh file is at most ${limit} bytes.`,
  job_dat_bytes: (limit) =>
    `Increase mesh_size_mm or request fewer printed fields so job.dat is at most ${limit} bytes.`,
  deck_bytes: (limit) =>
    `Increase mesh_size_mm or simplify the geometry so the CalculiX deck is at most ${limit} bytes.`,
  timeout_ms: (limit) =>
    `Use a timeout_ms no greater than ${MAX_SOLVE_TIMEOUT_MS}; if execution reached ${limit} ms, simplify the mesh or model, or increase timeout_ms within that fleet maximum.`,
  version_probe_bytes: (limit) =>
    `Install a Gmsh or CalculiX build whose version probe writes at most ${limit} bytes.`,
};

export function resourceBudgetError(
  code: ResourceBudgetCode,
  resource: ResourceBudgetName,
  limit: number,
  actual: number,
  unit: ResourceBudgetUnit,
): ResourceBudgetError {
  return new ResourceBudgetError({
    code,
    context: { resource, limit, actual, unit },
    recovery: RECOVERY[resource](limit),
  });
}

/** Clamp a test or caller override so it cannot raise a documented fleet maximum. */
export function tightenBudget(
  requested: number | undefined,
  fleet: number,
): number {
  if (requested === undefined) return fleet;
  if (!Number.isSafeInteger(requested) || requested < 0) {
    throw new TypeError("Budget override must be a non-negative safe integer.");
  }
  return Math.min(requested, fleet);
}

/** Fail closed when a declared size already exceeds the budget. */
export function assertBudget(
  actual: number,
  limit: number,
  code: ResourceBudgetCode,
  resource: ResourceBudgetName,
  unit: ResourceBudgetUnit,
): void {
  if (!Number.isSafeInteger(actual) || actual < 0 || actual > limit) {
    const reported = Number.isFinite(actual) ? actual : limit + 1;
    throw resourceBudgetError(code, resource, limit, reported, unit);
  }
}

export async function assertFileSizeAtMost(
  path: string,
  limit: number,
  code: ResourceBudgetCode,
  resource: ResourceBudgetName,
): Promise<number> {
  const file = await openBoundedRegularFile(path, limit, code, resource);
  try {
    return file.size;
  } finally {
    await file.handle.close();
  }
}

/**
 * Hash a file without retaining its bytes. The declared size is rejected
 * before any in-memory allocation of that size.
 */
export async function hashFileBounded(
  path: string,
  limit: number,
  resource: ResourceBudgetName,
): Promise<{ sha256: string; bytes: number }> {
  const file = await openBoundedRegularFile(
    path,
    limit,
    "resource_limit",
    resource,
  );
  try {
    const hasher = createHash("sha256");
    const buffer = new Uint8Array(64 * 1024);
    let bytes = 0;
    while (true) {
      const { bytesRead } = await file.handle.read(
        buffer,
        0,
        buffer.length,
        null,
      );
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > limit) {
        throw resourceBudgetError(
          "resource_limit",
          resource,
          limit,
          bytes,
          "bytes",
        );
      }
      hasher.update(buffer.subarray(0, bytesRead));
    }
    return { sha256: hasher.digest("hex"), bytes };
  } finally {
    await file.handle.close();
  }
}

/** Copy at most `limit` bytes. Grows of the source after stat fail closed. */
export async function copyFileBounded(
  source: string,
  destination: string,
  limit: number,
  resource: ResourceBudgetName,
): Promise<number> {
  const src = await openBoundedRegularFile(
    source,
    limit,
    "resource_limit",
    resource,
  );
  let destinationCreated = false;
  let completed = false;
  try {
    const dst = await Deno.open(destination, {
      write: true,
      createNew: true,
      mode: 0o600,
    });
    destinationCreated = true;
    let bytes = 0;
    try {
      const buffer = new Uint8Array(64 * 1024);
      while (true) {
        const { bytesRead } = await src.handle.read(
          buffer,
          0,
          buffer.length,
          null,
        );
        if (bytesRead === 0) break;
        bytes += bytesRead;
        if (bytes > limit) {
          throw resourceBudgetError(
            "resource_limit",
            resource,
            limit,
            bytes,
            "bytes",
          );
        }
        await writeAllBytes(dst, buffer.subarray(0, bytesRead));
      }
    } finally {
      dst.close();
    }
    completed = true;
    return bytes;
  } finally {
    try {
      await src.handle.close();
    } finally {
      if (destinationCreated && !completed) {
        await Deno.remove(destination).catch(() => {});
      }
    }
  }
}

/** Write a complete byte slice even when the underlying writer short-writes. */
export async function writeAllBytes(
  writer: { write(bytes: Uint8Array): Promise<number> },
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const written = await writer.write(bytes.subarray(offset));
    if (
      !Number.isSafeInteger(written) || written < 1 ||
      written > bytes.length - offset
    ) {
      throw new Error("File writer made no forward progress.");
    }
    offset += written;
  }
}

export async function readBytesBounded(
  path: string,
  limit: number,
  code: ResourceBudgetCode,
  resource: ResourceBudgetName,
): Promise<Uint8Array> {
  const file = await openBoundedRegularFile(path, limit, code, resource);
  try {
    const chunks: Uint8Array[] = [];
    const buffer = new Uint8Array(64 * 1024);
    let bytes = 0;
    while (true) {
      const { bytesRead } = await file.handle.read(
        buffer,
        0,
        buffer.length,
        null,
      );
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > limit) {
        throw resourceBudgetError(code, resource, limit, bytes, "bytes");
      }
      chunks.push(buffer.subarray(0, bytesRead).slice());
    }
    return concatBytes(chunks);
  } finally {
    await file.handle.close();
  }
}

interface OpenBoundedFile {
  handle: FileHandle;
  size: number;
}

/**
 * Open one stable regular-file identity. POSIX uses O_NOFOLLOW and O_NONBLOCK
 * so a namespace swap to a symlink, FIFO, or device cannot turn a size check
 * into an unbounded open. Symlinks supplied by callers are resolved once to
 * their regular target before the identity is anchored.
 */
async function openBoundedRegularFile(
  path: string,
  limit: number,
  code: ResourceBudgetCode,
  resource: ResourceBudgetName,
): Promise<OpenBoundedFile> {
  const resolved = await Deno.realPath(path);
  const before = await Deno.lstat(resolved);
  if (!before.isFile) {
    throw fileConstraintError(
      code,
      resource,
      limit,
      before.size,
      "non_regular_file",
    );
  }

  const posixFlags = Deno.build.os === "windows"
    ? 0
    : fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
  const handle = await openNodeFile(
    resolved,
    fsConstants.O_RDONLY | posixFlags,
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw fileConstraintError(
        code,
        resource,
        limit,
        opened.size,
        "non_regular_file",
      );
    }
    if (
      opened.dev !== before.dev ||
      (before.ino !== null && opened.ino !== before.ino)
    ) {
      throw fileConstraintError(
        code,
        resource,
        limit,
        opened.size,
        "file_identity_changed",
      );
    }
    assertBudget(opened.size, limit, code, resource, "bytes");
    return { handle, size: opened.size };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

function fileConstraintError(
  code: ResourceBudgetCode,
  resource: ResourceBudgetName,
  limit: number,
  actual: number,
  reason: "non_regular_file" | "file_identity_changed",
): ResourceBudgetError {
  return new ResourceBudgetError({
    code,
    context: { resource, limit, actual, unit: "bytes", reason },
    recovery: reason === "non_regular_file"
      ? `Provide a regular file for ${resource}; FIFOs, devices, sockets, and directories are not accepted.`
      : `Retry with a stable ${resource} file whose identity is not replaced during admission.`,
  });
}

export async function readTextFileBounded(
  path: string,
  limit: number,
  code: ResourceBudgetCode,
  resource: ResourceBudgetName,
): Promise<string> {
  const bytes = await readBytesBounded(path, limit, code, resource);
  return new TextDecoder().decode(bytes);
}

export async function runBoundedCommand(options: {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs: number;
  maxOutputBytes: number;
  resource: ResourceBudgetName;
}): Promise<{ success: boolean; code: number; diagnostics: string }> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new TypeError("timeoutMs must be a positive safe integer.");
  }
  if (
    !Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 0
  ) {
    throw new TypeError("maxOutputBytes must be a non-negative safe integer.");
  }

  let child: Deno.ChildProcess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const startedAt = performance.now();
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  const state = {
    total: 0,
    exceeded: false,
    timedOut: false,
    timeoutActualMs: 0,
  };

  try {
    child = new Deno.Command(options.command, {
      args: options.args,
      cwd: options.cwd,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      detached: Deno.build.os !== "windows",
    }).spawn();

    const terminate = () => terminateProcessTree(child!);

    timer = setTimeout(() => {
      state.timedOut = true;
      state.timeoutActualMs = Math.max(
        options.timeoutMs + 1,
        Math.ceil(performance.now() - startedAt),
      );
      terminate();
    }, options.timeoutMs);

    // A direct child can exit while one of its descendants still owns the
    // inherited pipes. Closing the process group when the leader settles keeps
    // stdout/stderr completion bounded even on that path.
    const status = child.status.finally(terminate);

    const [stdoutResult, stderrResult, statusResult] = await Promise.allSettled(
      [
        consumeBoundedStream(
          child.stdout,
          stdoutChunks,
          state,
          options.maxOutputBytes,
          terminate,
        ),
        consumeBoundedStream(
          child.stderr,
          stderrChunks,
          state,
          options.maxOutputBytes,
          terminate,
        ),
        status,
      ],
    );

    if (state.exceeded) {
      throw resourceBudgetError(
        "output_limit",
        options.resource,
        options.maxOutputBytes,
        state.total,
        "bytes",
      );
    }
    if (state.timedOut) {
      throw resourceBudgetError(
        "resource_limit",
        "timeout_ms",
        options.timeoutMs,
        state.timeoutActualMs,
        "ms",
      );
    }
    if (statusResult.status === "rejected") throw statusResult.reason;
    if (stdoutResult.status === "rejected") throw stdoutResult.reason;
    if (stderrResult.status === "rejected") throw stderrResult.reason;

    return {
      success: statusResult.value.success,
      code: statusResult.value.code,
      diagnostics: new TextDecoder().decode(concatBytes(stdoutChunks)) +
        new TextDecoder().decode(concatBytes(stderrChunks)),
    };
  } catch (error) {
    if (state.exceeded && !(error instanceof ResourceBudgetError)) {
      throw resourceBudgetError(
        "output_limit",
        options.resource,
        options.maxOutputBytes,
        state.total,
        "bytes",
      );
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (child !== undefined) {
      terminateProcessTree(child);
      await child.status.catch(() => {});
    }
  }
}

async function consumeBoundedStream(
  stream: ReadableStream<Uint8Array>,
  chunks: Uint8Array[],
  state: { total: number; exceeded: boolean },
  limit: number,
  terminate: () => void,
): Promise<void> {
  const reader = stream.getReader();
  try {
    while (!state.exceeded) {
      const { done, value } = await reader.read();
      if (done || value === undefined) return;
      if (state.exceeded) return;
      const next = state.total + value.byteLength;
      if (next > limit) {
        state.total = next;
        state.exceeded = true;
        terminate();
        return;
      }
      state.total = next;
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch { /* already closed */ }
    reader.releaseLock();
  }
}

function terminateProcessTree(child: Deno.ChildProcess): void {
  if (Deno.build.os !== "windows") {
    try {
      Deno.kill(-child.pid, "SIGKILL");
      return;
    } catch { /* process group already exited */ }
  }
  try {
    child.kill("SIGKILL");
  } catch { /* direct child already exited */ }
}

/** Convert a bounded business failure into an agent-readable MCP error body. */
export function mapCalculixToolError(
  error: unknown,
  toolName: string,
): string | null {
  if (!(error instanceof ResourceBudgetError)) return null;
  return JSON.stringify({
    code: error.code,
    context: { ...error.context, tool: toolName },
    recovery: error.recovery,
  });
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
