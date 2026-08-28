/** Stable, content-attested STEP input snapshots for one CalculiX operation. */

export interface InputArtifact {
  /** Private snapshot path actually passed to Gmsh. Ephemeral after the call. */
  path: string;
  /** Caller-provided location copied into the private snapshot. */
  sourcePath: string;
  /** SHA-256 computed from the private snapshot bytes. */
  sha256: string;
  bytes: number;
}

export class InputArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputArtifactError";
  }
}

export interface StepSnapshot {
  artifact: InputArtifact;
  cleanup(): Promise<void>;
}

function sha256Hex(bytes: Uint8Array): Promise<string> {
  const contiguous = Uint8Array.from(bytes);
  return crypto.subtle.digest("SHA-256", contiguous.buffer).then((digest) =>
    Array.from(
      new Uint8Array(digest),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("")
  );
}

/**
 * Copy a caller-controlled STEP path into a private per-call directory, then
 * attest and freeze that copy before any meshing subprocess starts. `operation`
 * only scopes diagnostic text; it never changes the snapshot contract.
 *
 * Hashing after the copy is deliberate: it proves the exact bytes Gmsh will
 * consume, even if the source path is concurrently replaced.  An expected
 * digest is checked against this computed value, never echoed from the input.
 */
export async function snapshotStepArtifact(
  sourcePath: string,
  expectedSha256?: string,
  operation = "calculix_solve_static",
): Promise<StepSnapshot> {
  if (
    expectedSha256 !== undefined &&
    !/^[a-fA-F0-9]{64}$/.test(expectedSha256)
  ) {
    throw new InputArtifactError(
      `[${operation}] expected_step_sha256 must be a 64-character hexadecimal SHA-256 digest.`,
    );
  }

  const workDir = await Deno.makeTempDir({ prefix: "calculix-input-" });
  const snapshotPath = `${workDir}/input.step`;
  // Cleanup is best-effort: callers must not treat the ephemeral path as a
  // durable handle even if the host refuses its removal.
  const cleanup = () =>
    Deno.remove(workDir, { recursive: true }).catch(() => {});

  try {
    await Deno.copyFile(sourcePath, snapshotPath);
    const bytes = await Deno.readFile(snapshotPath);
    if (bytes.length === 0) {
      throw new InputArtifactError(
        `[${operation}] STEP input is empty: ${sourcePath}`,
      );
    }
    const sha256 = await sha256Hex(bytes);
    if (
      expectedSha256 !== undefined &&
      sha256 !== expectedSha256.toLowerCase()
    ) {
      throw new InputArtifactError(
        `[${operation}] STEP SHA-256 mismatch: expected ${expectedSha256.toLowerCase()}, computed ${sha256} from the private input snapshot.`,
      );
    }

    // The random private directory is not exposed until the result returns;
    // read-only mode makes accidental in-process modification fail as well.
    await Deno.chmod(snapshotPath, 0o400);
    return {
      artifact: {
        path: snapshotPath,
        sourcePath,
        sha256,
        bytes: bytes.length,
      },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    if (error instanceof InputArtifactError) throw error;
    if (error instanceof Deno.errors.NotFound) {
      throw new InputArtifactError(
        `[${operation}] STEP file not found: ${sourcePath}`,
      );
    }
    throw error;
  }
}
