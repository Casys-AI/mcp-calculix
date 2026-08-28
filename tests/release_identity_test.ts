import { assert, assertEquals } from "@std/assert";
import { TextLineStream } from "@std/streams/text-line-stream";
import { createCalculixServer } from "../server.ts";
import {
  parseRecordedStaticExecutionIdentity,
  resolveRecordedStaticRequest,
} from "../src/runs.ts";

const PROTOCOL_VERSION = "2026-07-28";
const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";
const CURRENT_RELEASE_VERSION = "0.8.2";
const CURRENT_RELEASE_INDEX_DIGEST =
  "c38fe50eadcca77180c2bc060c073035af62924fa2b927d3f8005b6060be76d4";
const CURRENT_DEPLOYMENT_IMAGE =
  `ghcr.io/casys-ai/mcp-calculix@sha256:${CURRENT_RELEASE_INDEX_DIGEST}`;
const CURRENT_DISCOVERY_TAG =
  `ghcr.io/casys-ai/mcp-calculix:${CURRENT_RELEASE_VERSION}`;
const packageMetadata = JSON.parse(
  await Deno.readTextFile(new URL("../deno.json", import.meta.url)),
) as { version?: unknown };
const PACKAGE_VERSION = packageMetadata.version;

assert(
  typeof PACKAGE_VERSION === "string" && PACKAGE_VERSION.length > 0,
  "deno.json must declare a non-empty package version.",
);

Deno.test(
  "release identities match deno.json across transports, provenance, and viewer",
  async () => {
    const expected = PACKAGE_VERSION;
    assertEquals(
      expected,
      CURRENT_RELEASE_VERSION,
      "Update the current release deployment digest when deno.json version changes.",
    );

    assertReleaseVersion(
      "HTTP server",
      await httpServerVersion(),
      expected,
    );
    assertReleaseVersion(
      "native stdio server",
      await nativeStdioServerVersion(),
      expected,
    );

    const solveSource = await Deno.readTextFile(
      new URL("../src/tools/solve.ts", import.meta.url),
    );
    const provenanceVersion = defaultRecordedProvenanceVersion(solveSource);
    assertReleaseVersion(
      "default recorded execution provenance",
      provenanceVersion,
      expected,
    );
    const sealed = resolveRecordedStaticRequest(
      recordedRequest(),
      parseRecordedStaticExecutionIdentity({
        schema_version: "1.0",
        server: {
          package: "@casys/mcp-calculix",
          version: provenanceVersion,
        },
        method: { id: "calculix_solve_static_recorded", version: "1.0" },
        lowering: { id: "calculix.static.abaqus-deck", version: "1.0" },
        engines: {
          gmsh: { command: "gmsh", version: "release-guard" },
          ccx: { command: "ccx", version: "release-guard" },
        },
        image: { status: "unattested" },
      }),
    );
    assertReleaseVersion(
      "sealed recorded execution provenance",
      sealed.executionIdentity.server.version,
      expected,
    );

    const viewerSource = await Deno.readTextFile(
      new URL("../src/ui/results-viewer/src/main.ts", import.meta.url),
    );
    assertReleaseVersion(
      "results viewer source",
      capturedVersion(
        viewerSource,
        /info:\s*\{\s*name:\s*"CalculiX Static Results",\s*version:\s*"([^"]+)"/,
        "results viewer source identity",
      ),
      expected,
    );

    const viewerBundle = await Deno.readTextFile(
      new URL("../src/ui/dist/results-viewer/index.html", import.meta.url),
    );
    assertReleaseVersion(
      "generated results viewer bundle",
      capturedVersion(
        viewerBundle,
        /info:\{name:"CalculiX Static Results",version:"([^"]+)"\}/,
        "generated results viewer bundle identity",
      ),
      expected,
    );

    const citation = await Deno.readTextFile(
      new URL("../CITATION.cff", import.meta.url),
    );
    assertReleaseVersion(
      "citation metadata",
      capturedVersion(
        citation,
        /^version:\s*([^\s]+)\s*$/m,
        "citation version",
      ),
      expected,
    );

    const readme = await Deno.readTextFile(
      new URL("../README.md", import.meta.url),
    );
    assert(
      readme.includes(`Version \`${expected}\``),
      "README must describe the package version declared in deno.json.",
    );
    assert(
      readme.includes(CURRENT_DEPLOYMENT_IMAGE),
      "README must publish the current qualified deployment image digest.",
    );
    assert(
      readme.includes(
        `\`${CURRENT_DISCOVERY_TAG}\` is a mutable discovery tag, not a\n` +
          "qualified deployment identity.",
      ),
      "README must describe the current release tag as mutable discovery only.",
    );
    assert(
      readme.includes(`docker pull ${CURRENT_DEPLOYMENT_IMAGE}`),
      "README Docker pull example must use the qualified index digest.",
    );
    assert(
      readme.includes(`  ${CURRENT_DEPLOYMENT_IMAGE} http`),
      "README HTTP Docker run example must use the qualified index digest.",
    );
    assert(
      readme.includes(`        \"${CURRENT_DEPLOYMENT_IMAGE}\",`),
      "README stdio Docker run example must use the qualified index digest.",
    );
    assert(
      !readme.includes(`docker pull ${CURRENT_DISCOVERY_TAG}`) &&
        !readme.includes(`  ${CURRENT_DISCOVERY_TAG} http`) &&
        !readme.includes(`        \"${CURRENT_DISCOVERY_TAG}\",`),
      "README deployment, pull, and run examples must not use the mutable release tag.",
    );
  },
);

async function httpServerVersion(): Promise<unknown> {
  const { app } = createCalculixServer({ logger: () => {} });
  const port = freePort();
  const http = await app.startHttp({
    port,
    hostname: "127.0.0.1",
    onListen: () => {},
  });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": PROTOCOL_VERSION,
        "mcp-method": "server/discover",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": {
              name: "release-identity-guard",
              version: "0",
            },
          },
        },
      }),
    });
    assertEquals(response.status, 200);
    const body = await response.json();
    assertRecord(body, "HTTP discovery response");
    assertRecord(body.result, "HTTP discovery result");
    assertEquals(body.result.resultType, "complete");
    assertRecord(body.result.serverInfo, "HTTP server identity");
    assertEquals(body.result.serverInfo.name, "mcp-calculix");
    return body.result.serverInfo.version;
  } finally {
    await http.shutdown();
  }
}

async function nativeStdioServerVersion(): Promise<unknown> {
  const runsDirectory = await Deno.makeTempDir({
    prefix: "mcp-calculix-release-identity-",
  });
  const server = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-all",
      new URL("../server.ts", import.meta.url).pathname,
      "--stdio",
    ],
    env: { CALCULIX_RUNS_DIRECTORY: runsDirectory },
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const writer = server.stdin.getWriter();
  try {
    await writer.write(new TextEncoder().encode(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": {
              name: "release-identity-guard",
              version: "0",
            },
          },
        },
      }) + "\n",
    ));
    const response = await readJsonLine(server.stdout, 30_000);
    assertRecord(response, "native stdio discovery response");
    assertRecord(response.result, "native stdio discovery result");
    assertEquals(response.result.resultType, "complete");
    assertRecord(response.result._meta, "native stdio discovery metadata");
    assertRecord(
      response.result._meta[SERVER_INFO_KEY],
      "native stdio server identity",
    );
    const serverInfo = response.result._meta[SERVER_INFO_KEY];
    assertEquals(serverInfo.name, "mcp-calculix");
    return serverInfo.version;
  } finally {
    await writer.close().catch(() => undefined);
    try {
      server.kill("SIGTERM");
    } catch {
      // The server may have exited after stdin closed.
    }
    await server.status;
    await Deno.remove(runsDirectory, { recursive: true });
  }
}

async function readJsonLine(
  stdout: ReadableStream<Uint8Array>,
  timeoutMs: number,
): Promise<unknown> {
  const reader = stdout
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new TextLineStream())
    .getReader();
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    while (true) {
      const { value, done } = await readBeforeTimeout(reader, timeout);
      if (done) {
        throw new Error("Native stdio closed before discovery response.");
      }
      if (value.trim() !== "") return JSON.parse(value) as unknown;
    }
  } finally {
    reader.releaseLock();
  }
}

function readBeforeTimeout(
  reader: ReadableStreamDefaultReader<string>,
  timeout: AbortSignal,
): Promise<ReadableStreamReadResult<string>> {
  return new Promise((resolve, reject) => {
    const rejectTimeout = () =>
      reject(new Error("Timed out waiting for native stdio discovery."));
    timeout.addEventListener("abort", rejectTimeout, { once: true });
    reader.read().then(
      (result) => {
        timeout.removeEventListener("abort", rejectTimeout);
        resolve(result);
      },
      (error) => {
        timeout.removeEventListener("abort", rejectTimeout);
        reject(error);
      },
    );
  });
}

function defaultRecordedProvenanceVersion(source: string): string {
  const start = source.indexOf("async function resolveExecutionIdentity()");
  const end = source.indexOf("\nasync function executableVersion(", start);
  assert(
    start >= 0 && end > start,
    "Cannot find the default recorded execution identity resolver.",
  );
  return capturedVersion(
    source.slice(start, end),
    /server:\s*\{\s*package:\s*"@casys\/mcp-calculix",\s*version:\s*"([^"]+)"/,
    "default recorded execution provenance identity",
  );
}

function capturedVersion(
  source: string,
  pattern: RegExp,
  identity: string,
): string {
  const match = source.match(pattern);
  assert(match, `Cannot find ${identity}.`);
  return match[1];
}

function assertReleaseVersion(
  identity: string,
  actual: unknown,
  expected: string,
): void {
  assertEquals(
    actual,
    expected,
    `${identity} identity is stale: advertised ${
      String(actual)
    }, expected ${expected} from deno.json.`,
  );
}

function recordedRequest(): Record<string, unknown> {
  return {
    request_id: "release-identity-guard",
    step_path: "/release-identity-guard/input.step",
    expected_step_sha256: "a".repeat(64),
    mesh_size_mm: 1,
    material: { e_mpa: 70_000, nu: 0.3 },
    selections: [
      { name: "FIX", box: { min: [0, 0, 0], max: [1, 1, 1] } },
      { name: "LOAD", box: { min: [1, 0, 0], max: [2, 1, 1] } },
    ],
    fixed: ["FIX"],
    loads: [{ selection: "LOAD", force_n: [0, 0, -1] }],
  };
}

function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

function assertRecord(
  value: unknown,
  name: string,
): asserts value is Record<string, unknown> {
  assert(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${name} must be an object.`,
  );
}
