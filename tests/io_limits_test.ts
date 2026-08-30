/**
 * Adversarial I/O and cardinality budgets: fail before full in-memory reads
 * and while streaming subprocess output.
 */

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  copyFileBounded,
  hashFileBounded,
  MAX_NSET_NODES,
  MAX_SELECTIONS,
  MAX_SOLVE_TIMEOUT_MS,
  MAX_STEP_BYTES,
  MAX_TOTAL_NSET_MEMBERSHIPS,
  readBytesBounded,
  ResourceBudgetError,
  runBoundedCommand,
  writeAllBytes,
} from "../src/api/budgets.ts";
import { solveDeck } from "../src/api/ccx.ts";
import {
  cleanInp,
  inspectInp,
  meshStep,
  parseNsetNodeIds,
} from "../src/api/gmsh.ts";
import { snapshotStepArtifact } from "../src/api/input-artifact.ts";
import {
  parseMeshPreflightArgs,
  parseOrdinarySolveArgs,
} from "../src/tools/ordinary-preflight.ts";
import {
  type RecordedStaticExecutionIdentity,
  resolveRecordedStaticRequest,
} from "../src/runs.ts";
import { createRecordedStaticTools } from "../src/tools/solve.ts";
import { CalculixRunStore } from "../src/runs.ts";

const IDENTITY: RecordedStaticExecutionIdentity = {
  schema_version: "1.0",
  server: { package: "@casys/mcp-calculix", version: "0.8.2" },
  method: { id: "calculix_solve_static_recorded", version: "1.0" },
  lowering: { id: "calculix.static.abaqus-deck", version: "1.0" },
  engines: {
    gmsh: { command: "gmsh", version: "budget-test" },
    ccx: { command: "ccx", version: "budget-test" },
  },
  image: { status: "unattested" },
};

Deno.test("snapshotStepArtifact refuses an oversized STEP before hashing bytes", async () => {
  const directory = await Deno.makeTempDir({ prefix: "calculix-step-budget-" });
  const source = join(directory, "huge.step");
  try {
    await Deno.writeFile(source, new Uint8Array(0));
    await Deno.truncate(source, MAX_STEP_BYTES + 1);
    const error = await assertRejects(
      () => snapshotStepArtifact(source),
      ResourceBudgetError,
    );
    assertEquals(error.code, "resource_limit");
    assertEquals(error.context.resource, "step_bytes");
    assertEquals(error.context.limit, MAX_STEP_BYTES);
    assertEquals(error.context.actual, MAX_STEP_BYTES + 1);
    assertEquals(error.context.unit, "bytes");
    assert(error.recovery.includes(String(MAX_STEP_BYTES)));
    assert(error.message.includes("resource_limit"));
    assert(error.message.includes(error.recovery));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("bounded copy/hash/read helpers fail closed on a tiny oversize file", async () => {
  const directory = await Deno.makeTempDir({ prefix: "calculix-tiny-budget-" });
  const source = join(directory, "input.bin");
  const destination = join(directory, "copy.bin");
  try {
    await Deno.writeFile(source, new Uint8Array(8).fill(7));
    const copyError = await assertRejects(
      () => copyFileBounded(source, destination, 7, "step_bytes"),
      ResourceBudgetError,
    );
    assertEquals(copyError.code, "resource_limit");
    assertEquals(copyError.context.actual, 8);

    const hashError = await assertRejects(
      () => hashFileBounded(source, 7, "step_bytes"),
      ResourceBudgetError,
    );
    assertEquals(hashError.code, "resource_limit");

    const readError = await assertRejects(
      () => readBytesBounded(source, 7, "output_limit", "job_dat_bytes"),
      ResourceBudgetError,
    );
    assertEquals(readError.code, "output_limit");
    assertEquals(readError.context.resource, "job_dat_bytes");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("bounded file helpers reject non-regular files before reading", async () => {
  const directory = await Deno.makeTempDir({ prefix: "calculix-file-type-" });
  try {
    const error = await assertRejects(
      () =>
        readBytesBounded(
          directory,
          16,
          "output_limit",
          "job_dat_bytes",
        ),
      ResourceBudgetError,
    );
    assertEquals(error.code, "output_limit");
    assertEquals(error.context.reason, "non_regular_file");
    assert(error.recovery.includes("regular file"));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test({
  name: "bounded file helpers reject a FIFO without blocking on open",
  ignore: Deno.build.os === "windows",
  async fn() {
    const directory = await Deno.makeTempDir({ prefix: "calculix-fifo-" });
    const fifo = join(directory, "input.pipe");
    try {
      const made = await new Deno.Command("mkfifo", { args: [fifo] }).output();
      assertEquals(made.success, true);
      const started = performance.now();
      const error = await assertRejects(
        () => hashFileBounded(fifo, 16, "step_bytes"),
        ResourceBudgetError,
      );
      assertEquals(error.context.reason, "non_regular_file");
      assert(performance.now() - started < 1_000);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});

Deno.test("writeAllBytes completes short writes and rejects zero progress", async () => {
  const chunks: Uint8Array[] = [];
  await writeAllBytes({
    write(bytes) {
      const accepted = bytes.subarray(0, Math.min(2, bytes.length)).slice();
      chunks.push(accepted);
      return Promise.resolve(accepted.length);
    },
  }, new TextEncoder().encode("abcdef"));
  assertEquals(
    new TextDecoder().decode(
      new Uint8Array(chunks.flatMap((chunk) => [...chunk])),
    ),
    "abcdef",
  );
  await assertRejects(
    () =>
      writeAllBytes({ write: () => Promise.resolve(0) }, new Uint8Array([1])),
    Error,
    "no forward progress",
  );
});

Deno.test("bounded copy refuses an existing destination without truncating it", async () => {
  const directory = await Deno.makeTempDir({ prefix: "calculix-copy-target-" });
  const source = join(directory, "source.step");
  const destination = join(directory, "destination.step");
  try {
    await Deno.writeTextFile(source, "source");
    await Deno.writeTextFile(destination, "sentinel");
    await assertRejects(
      () => copyFileBounded(source, destination, 32, "step_bytes"),
      Deno.errors.AlreadyExists,
    );
    assertEquals(await Deno.readTextFile(destination), "sentinel");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test({
  name:
    "runBoundedCommand kills a process group that exceeds the diagnostic budget",
  ignore: Deno.build.os === "windows",
  async fn() {
    const directory = await Deno.makeTempDir({
      prefix: "calculix-stream-reap-",
    });
    const pidPath = join(directory, "pid");
    const childPidPath = join(directory, "child-pid");
    try {
      const started = performance.now();
      const error = await assertRejects(
        () =>
          runBoundedCommand({
            command: "/bin/sh",
            args: [
              "-c",
              `echo $$ > ${JSON.stringify(pidPath)}; ` +
              `/bin/sleep 30 & echo $! > ${JSON.stringify(childPidPath)}; ` +
              `while :; do printf xxxxxxxx; done`,
            ],
            timeoutMs: 5_000,
            maxOutputBytes: 32,
            resource: "gmsh_diagnostics",
          }),
        ResourceBudgetError,
      );
      assertEquals(error.code, "output_limit");
      assertEquals(error.context.resource, "gmsh_diagnostics");
      assertEquals(error.context.limit, 32);
      assert(error.context.actual > 32);
      assert(error.recovery.length > 0);
      assert(performance.now() - started < 2_000);
      await assertProcessReaped(pidPath);
      await assertProcessStopped(childPidPath);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "runBoundedCommand returns a stable timeout error and kills descendants retaining pipes",
  ignore: Deno.build.os === "windows",
  async fn() {
    const directory = await Deno.makeTempDir({
      prefix: "calculix-timeout-reap-",
    });
    const pidPath = join(directory, "pid");
    const childPidPath = join(directory, "child-pid");
    try {
      const started = performance.now();
      const error = await assertRejects(
        () =>
          runBoundedCommand({
            command: "/bin/sh",
            args: [
              "-c",
              `echo $$ > ${JSON.stringify(pidPath)}; ` +
              `/bin/sleep 30 & echo $! > ${JSON.stringify(childPidPath)}; wait`,
            ],
            timeoutMs: 200,
            maxOutputBytes: 1_024,
            resource: "ccx_diagnostics",
          }),
        ResourceBudgetError,
      );
      assertEquals(error.code, "resource_limit");
      assertEquals(error.context.resource, "timeout_ms");
      assertEquals(error.context.limit, 200);
      assert(error.context.actual > 200);
      assert(error.recovery.includes(String(MAX_SOLVE_TIMEOUT_MS)));
      assert(performance.now() - started < 2_000);
      await assertProcessReaped(pidPath);
      await assertProcessStopped(childPidPath);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});

Deno.test("meshStep refuses oversized Gmsh diagnostics without retaining the log", async () => {
  await withFakeCommand("gmsh", [
    "printf '%065d' 0",
    "printf '*NODE\\n1,0,0,0\\n' > mesh.inp",
  ], async (stepPath) => {
    const error = await assertRejects(
      () =>
        meshStep({
          stepPath,
          selections: [{
            name: "FACE",
            box: { min: [0, 0, 0], max: [1, 1, 1] },
          }],
          meshSizeMm: 1,
          elementOrder: 1,
          timeoutMs: 5_000,
          budgets: { maxDiagnosticsBytes: 64 },
        }),
      ResourceBudgetError,
    );
    assertEquals(error.code, "output_limit");
    assertEquals(error.context.resource, "gmsh_diagnostics");
    assertEquals(error.context.limit, 64);
    assert(error.context.actual > 64);
  });
});

Deno.test("inspectInp refuses mesh node and element cardinality over a tiny budget", () => {
  const nodeError = assertThrows(
    () =>
      inspectInp("*NODE\n1,0,0,0\n2,0,0,0\n3,0,0,0\n", {
        maxMeshNodes: 2,
      }),
    ResourceBudgetError,
  );
  assertEquals(nodeError.code, "output_limit");
  assertEquals(nodeError.context.resource, "mesh_nodes");
  assertEquals(nodeError.context.limit, 2);
  assertEquals(nodeError.context.actual, 3);
  assert(nodeError.recovery.length > 0);

  const elementError = assertThrows(
    () =>
      inspectInp(
        "*NODE\n1,0,0,0\n*ELEMENT, type=C3D4\n1,1,1,1,1\n2,1,1,1,1\n",
        { maxMeshElements: 1 },
      ),
    ResourceBudgetError,
  );
  assertEquals(elementError.code, "output_limit");
  assertEquals(elementError.context.resource, "mesh_elements");
  assertEquals(elementError.context.actual, 2);
});

Deno.test("parseNsetNodeIds refuses an oversized GENERATE range before allocating it", () => {
  const started = performance.now();
  const error = assertThrows(
    () =>
      parseNsetNodeIds(
        `*NSET, NSET=FIXED, GENERATE\n1, ${MAX_NSET_NODES + 1}\n`,
      ),
    ResourceBudgetError,
  );
  assertEquals(error.code, "output_limit");
  assertEquals(error.context.resource, "nset_nodes");
  assertEquals(error.context.limit, MAX_NSET_NODES);
  assertEquals(error.context.actual, MAX_NSET_NODES + 1);
  assert(performance.now() - started < 250);

  const listError = assertThrows(
    () =>
      parseNsetNodeIds("*NSET, NSET=FIXED\n1, 2, 3, 4\n", {
        maxNsetNodes: 3,
      }),
    ResourceBudgetError,
  );
  assertEquals(listError.context.actual, 4);
  assertEquals(listError.context.limit, 3);

  const generateError = assertThrows(
    () =>
      parseNsetNodeIds("*NSET, NSET=FIXED, GENERATE\n1, 4\n", {
        maxNsetNodes: 3,
      }),
    ResourceBudgetError,
  );
  assertEquals(generateError.context.actual, 4);
  assertEquals(generateError.context.limit, 3);
});

Deno.test("parseNsetNodeIds bounds total memberships and parses direct lines incrementally", () => {
  const cumulative = assertThrows(
    () =>
      parseNsetNodeIds(
        "*NSET, NSET=A\n1,2,3\n*NSET, NSET=B\n4,5,6\n",
        { maxNsetNodes: 3, maxTotalNsetMemberships: 4 },
      ),
    ResourceBudgetError,
  );
  assertEquals(cumulative.code, "output_limit");
  assertEquals(cumulative.context.resource, "nset_memberships");
  assertEquals(cumulative.context.limit, 4);
  assertEquals(cumulative.context.actual, 5);

  const oversizedLine = `1,2,3,4,${"5,".repeat(100_000)}`;
  const started = performance.now();
  const direct = assertThrows(
    () =>
      parseNsetNodeIds(`*NSET, NSET=A\n${oversizedLine}\n`, {
        maxNsetNodes: 3,
        maxTotalNsetMemberships: MAX_TOTAL_NSET_MEMBERSHIPS,
      }),
    ResourceBudgetError,
  );
  assertEquals(direct.context.resource, "nset_nodes");
  assertEquals(direct.context.actual, 4);
  assert(performance.now() - started < 250);

  const duplicateWork = assertThrows(
    () =>
      parseNsetNodeIds("*NSET, NSET=A\n1,1,1,1\n", {
        maxNsetNodes: MAX_NSET_NODES,
        maxNsetEntries: 3,
      }),
    ResourceBudgetError,
  );
  assertEquals(duplicateWork.code, "output_limit");
  assertEquals(duplicateWork.context.resource, "nset_entries");
  assertEquals(duplicateWork.context.actual, 4);

  const overlappingRanges = assertThrows(
    () =>
      parseNsetNodeIds(
        "*NSET, NSET=A, GENERATE\n1,3\n1,3\n",
        { maxNsetNodes: 3, maxNsetEntries: 4 },
      ),
    ResourceBudgetError,
  );
  assertEquals(overlappingRanges.context.resource, "nset_entries");
  assertEquals(overlappingRanges.context.actual, 6);
  assertEquals(overlappingRanges.context.limit, 4);

  const emptySets = assertThrows(
    () =>
      parseNsetNodeIds(
        "*NSET, NSET=A\n*NSET, NSET=B\n*NSET, NSET=C\n",
        { maxNsetSets: 2 },
      ),
    ResourceBudgetError,
  );
  assertEquals(emptySets.code, "output_limit");
  assertEquals(emptySets.context.resource, "nset_sets");
  assertEquals(emptySets.context.actual, 3);
});

Deno.test("cleanInp bounds line work without allocating a split-line array", () => {
  const error = assertThrows(
    () => cleanInp("*NODE\n1,0,0,0\n2,0,0,0\n", { maxMeshLines: 2 }),
    ResourceBudgetError,
  );
  assertEquals(error.code, "output_limit");
  assertEquals(error.context.resource, "mesh_lines");
  assertEquals(error.context.limit, 2);
  assertEquals(error.context.actual, 3);
});

Deno.test("ordinary and mesh-preflight selection cardinality is a resource_limit", () => {
  const selections = Array.from({ length: MAX_SELECTIONS + 1 }, (_, index) => ({
    name: `S${index}`,
    box: { min: [index, 0, 0], max: [index + 0.5, 1, 1] },
  }));
  const ordinary = assertThrows(
    () =>
      parseOrdinarySolveArgs({
        step_path: "/missing.step",
        mesh_size_mm: 4,
        material: { e_mpa: 70000, nu: 0.33 },
        selections,
        fixed: ["S0"],
        loads: [{ selection: "S1", force_n: [0, 0, -1] }],
      }, {
        toolName: "calculix_solve_static",
        loads: "required",
      }),
    ResourceBudgetError,
  );
  assertEquals(ordinary.code, "resource_limit");
  assertEquals(ordinary.context.resource, "selections");
  assertEquals(ordinary.context.actual, MAX_SELECTIONS + 1);
  assert(ordinary.recovery.includes(String(MAX_SELECTIONS)));

  const preflight = assertThrows(
    () =>
      parseMeshPreflightArgs({
        step_path: "/missing.step",
        mesh_size_mm: 4,
        selections,
      }),
    ResourceBudgetError,
  );
  assertEquals(preflight.code, "resource_limit");
  assertEquals(preflight.context.resource, "selections");
});

Deno.test("meshStep refuses an oversized mesh.inp before parsing it", async () => {
  await withFakeCommand("gmsh", [
    "dd if=/dev/zero of=mesh.inp bs=65 count=1 2>/dev/null",
  ], async (stepPath) => {
    const error = await assertRejects(
      () =>
        meshStep({
          stepPath,
          selections: [{
            name: "FACE",
            box: { min: [0, 0, 0], max: [1, 1, 1] },
          }],
          meshSizeMm: 1,
          elementOrder: 1,
          timeoutMs: 5_000,
          budgets: { maxMeshInpBytes: 64 },
        }),
      ResourceBudgetError,
    );
    assertEquals(error.code, "output_limit");
    assertEquals(error.context.resource, "mesh_inp_bytes");
    assertEquals(error.context.limit, 64);
    assertEquals(error.context.actual, 65);
  });
});

Deno.test("solveDeck refuses an oversized job.dat before parsing result rows", async () => {
  await withFakeCommand("ccx", [
    "dd if=/dev/zero of=job.dat bs=65 count=1 2>/dev/null",
  ], async () => {
    const error = await assertRejects(
      () => solveDeck("*HEADING\n", 5_000, { maxJobDatBytes: 64 }),
      ResourceBudgetError,
    );
    assertEquals(error.code, "output_limit");
    assertEquals(error.context.resource, "job_dat_bytes");
    assertEquals(error.context.limit, 64);
    assertEquals(error.context.actual, 65);
  });
});

Deno.test("solveDeck refuses an oversized deck before spawning ccx", async () => {
  const error = await assertRejects(
    () => solveDeck("*HEADING\noversize\n", 1_000, { maxDeckBytes: 4 }),
    ResourceBudgetError,
  );
  assertEquals(error.code, "resource_limit");
  assertEquals(error.context.resource, "deck_bytes");
  assert(error.context.actual > 4);
});

Deno.test("solveDeck refuses oversized CalculiX diagnostics while ccx is running", async () => {
  await withFakeCommand("ccx", ["printf '%065d' 0"], async () => {
    const error = await assertRejects(
      () => solveDeck("*HEADING\n", 5_000, { maxDiagnosticsBytes: 64 }),
      ResourceBudgetError,
    );
    assertEquals(error.code, "output_limit");
    assertEquals(error.context.resource, "ccx_diagnostics");
    assertEquals(error.context.limit, 64);
    assert(error.context.actual > 64);
  });
});

Deno.test("recorded static timeout and selection cardinality share the fleet budgets", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "calculix-recorded-budget-",
  });
  try {
    const store = new CalculixRunStore({
      runsDirectory: join(directory, "runs"),
    });
    const tools = createRecordedStaticTools(store);
    const tool = tools.find((candidate) =>
      candidate.name === "calculix_solve_static_recorded"
    );
    assert(tool);
    const validateInput = new Ajv2020({ strict: false }).compile(
      tool.inputSchema,
    );
    const base = recordedArgs("/missing.step");
    assertEquals(
      validateInput({ ...base, timeout_ms: MAX_SOLVE_TIMEOUT_MS + 1 }),
      false,
    );
    const timeoutSchema = (tool.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >).timeout_ms;
    assertEquals(timeoutSchema.maximum, MAX_SOLVE_TIMEOUT_MS);

    const timeoutError = assertThrows(
      () =>
        resolveRecordedStaticRequest({
          ...base,
          timeout_ms: MAX_SOLVE_TIMEOUT_MS + 1,
        }, IDENTITY),
      ResourceBudgetError,
    );
    assertEquals(timeoutError.code, "resource_limit");
    assertEquals(timeoutError.context.resource, "timeout_ms");
    assertEquals(timeoutError.context.limit, MAX_SOLVE_TIMEOUT_MS);
    assert(timeoutError.recovery.includes(String(MAX_SOLVE_TIMEOUT_MS)));

    const selections = Array.from(
      { length: MAX_SELECTIONS + 1 },
      (_, index) => ({
        name: `S${index}`,
        box: { min: [index, 0, 0], max: [index + 0.5, 1, 1] },
      }),
    );
    const selectionError = assertThrows(
      () =>
        resolveRecordedStaticRequest({
          ...base,
          selections,
          fixed: ["S0"],
          loads: [{ selection: "S1", force_n: [0, 0, -1] }],
        }, IDENTITY),
      ResourceBudgetError,
    );
    assertEquals(selectionError.code, "resource_limit");
    assertEquals(selectionError.context.resource, "selections");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

function recordedArgs(stepPath: string): Record<string, unknown> {
  return {
    request_id: "budget-request",
    step_path: stepPath,
    expected_step_sha256: "a".repeat(64),
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

async function withFakeCommand(
  name: "gmsh" | "ccx",
  lines: string[],
  fn: (stepPath: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: `calculix-fake-${name}-` });
  const bin = join(root, "bin");
  const temporary = join(root, "tmp");
  const stepPath = join(root, "input.step");
  await Deno.mkdir(bin);
  await Deno.mkdir(temporary);
  await Deno.writeTextFile(stepPath, "ISO-10303-21;\nEND-ISO-10303-21;\n");
  await Deno.writeTextFile(join(bin, name), `#!/bin/sh\n${lines.join("\n")}\n`);
  await Deno.chmod(join(bin, name), 0o755);
  const previousPath = Deno.env.get("PATH");
  const previousTemp = Deno.env.get("TMPDIR");
  try {
    Deno.env.set("PATH", `${bin}${previousPath ? `:${previousPath}` : ""}`);
    Deno.env.set("TMPDIR", temporary);
    await fn(stepPath);
  } finally {
    restoreEnv("PATH", previousPath);
    restoreEnv("TMPDIR", previousTemp);
    await Deno.remove(root, { recursive: true });
  }
}

async function assertProcessReaped(pidPath: string): Promise<void> {
  const pid = Number((await Deno.readTextFile(pidPath)).trim());
  assert(Number.isInteger(pid) && pid > 0);
  const ps = await new Deno.Command("ps", {
    args: ["-p", String(pid)],
    stdout: "null",
    stderr: "null",
  }).output();
  assertEquals(ps.success, false, `pid ${pid} was not reaped`);
}

async function assertProcessStopped(pidPath: string): Promise<void> {
  const pid = Number((await Deno.readTextFile(pidPath)).trim());
  assert(Number.isInteger(pid) && pid > 0);
  for (let attempt = 0; attempt < 40; attempt++) {
    const ps = await new Deno.Command("ps", {
      args: ["-o", "stat=", "-p", String(pid)],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!ps.success) return;
    const state = new TextDecoder().decode(ps.stdout).trim();
    if (state.startsWith("Z")) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `descendant pid ${pid} remained live after group termination`,
  );
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) Deno.env.delete(name);
  else Deno.env.set(name, value);
}
