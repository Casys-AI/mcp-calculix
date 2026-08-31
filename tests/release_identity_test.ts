import { assert, assertEquals } from "@std/assert";
import { TextLineStream } from "@std/streams/text-line-stream";
import { createCalculixServer } from "../server.ts";
import {
  parseRecordedStaticExecutionIdentity,
  resolveRecordedStaticRequest,
} from "../src/runs.ts";
import {
  CALCULIX_VIEW_APP_MANIFEST,
  CALCULIX_VIEW_APP_MANIFEST_JSON,
} from "../src/viewer-session.ts";

const PROTOCOL_VERSION = "2026-07-28";
const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";
const CURRENT_RELEASE_VERSION = "0.8.5";
const CURRENT_DISCOVERY_TAG =
  `ghcr.io/casys-ai/mcp-calculix:${CURRENT_RELEASE_VERSION}`;
const RELEASE_IDENTITY_URL =
  `https://github.com/Casys-AI/mcp-calculix/releases/download/v${CURRENT_RELEASE_VERSION}/release-identity.json`;
const DEPLOYMENT_IMAGE_PREFIX = "ghcr.io/casys-ai/mcp-calculix@sha256:";
const packageMetadata = JSON.parse(
  await Deno.readTextFile(new URL("../deno.json", import.meta.url)),
) as { version?: unknown };
const PACKAGE_VERSION = packageMetadata.version;

assert(
  typeof PACKAGE_VERSION === "string" && PACKAGE_VERSION.length > 0,
  "deno.json must declare a non-empty package version.",
);

Deno.test(
  "source identities match deno.json while release docs stay on the attested tag",
  async () => {
    const expected = PACKAGE_VERSION;

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

    const manifestText = await Deno.readTextFile(
      new URL("../src/ui/app-manifest.json", import.meta.url),
    );
    const manifest = JSON.parse(manifestText) as {
      app?: { version?: unknown };
    };
    assertReleaseVersion(
      "serialized results viewer manifest",
      String(manifest.app?.version ?? ""),
      expected,
    );
    assertEquals(manifestText, CALCULIX_VIEW_APP_MANIFEST_JSON);
    assertEquals(JSON.parse(manifestText), CALCULIX_VIEW_APP_MANIFEST);
    const viewerSource = await Deno.readTextFile(
      new URL("../src/ui/results-viewer/src/app.ts", import.meta.url),
    );
    assert(
      viewerSource.includes("name: CALCULIX_VIEW_APP_MANIFEST.app.id") &&
        viewerSource.includes(
          "version: CALCULIX_VIEW_APP_MANIFEST.app.version",
        ),
      "results viewer appInfo must derive its exact id and version from the manifest",
    );

    const viewerBundle = await Deno.readTextFile(
      new URL("../src/ui/dist/results-viewer/index.html", import.meta.url),
    );
    assertReleaseVersion(
      "generated results viewer bundle",
      capturedVersion(
        viewerBundle,
        /app:\{id:"io\.casys\.mcp-calculix\.results",title:"CalculiX Static Results",version:"([^"]+)"\}/,
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
      readme.includes(`Source version \`${expected}\``),
      "README must describe the package version declared in deno.json.",
    );
    assert(
      readme.includes(
        `\`${CURRENT_DISCOVERY_TAG}\` is a mutable discovery tag, not a\n` +
          "qualified deployment identity.",
      ),
      "README must describe the current release tag as mutable discovery only.",
    );
    assert(
      readme.includes(RELEASE_IDENTITY_URL),
      "README must link the post-publication release identity artifact.",
    );
    assert(
      readme.includes(`RELEASE_IDENTITY_URL=${RELEASE_IDENTITY_URL}`) &&
        readme.includes(
          `curl -fsSLo release-identity.json "$RELEASE_IDENTITY_URL"`,
        ) &&
        readme.includes(`IMAGE_REF="$(jq -er '.image | select(test(`) &&
        readme.includes(`docker pull "$IMAGE_REF"`),
      "README must deploy the digest from the immutable release identity.",
    );
    assert(
      readme.includes(`  "$IMAGE_REF" http`),
      "README HTTP Docker run example must use the resolved digest reference.",
    );
    assert(
      readme.includes(
        `        \"${DEPLOYMENT_IMAGE_PREFIX}<digest from release-identity.json>\",`,
      ),
      "README stdio configuration must require the released digest.",
    );
    assert(
      !new RegExp(
        "ghcr\\.io/casys-ai/mcp-calculix@sha256:[a-f0-9]{64}",
      ).test(readme),
      "The immutable packaged README must not self-reference an image digest produced from its own bytes.",
    );

    const dockerWorkflow = await Deno.readTextFile(
      new URL("../.github/workflows/docker.yml", import.meta.url),
    );
    assert(
      dockerWorkflow.includes("id: image") &&
        dockerWorkflow.includes(
          "group: docker-${{ github.repository }}-${{ github.ref }}",
        ) &&
        dockerWorkflow.includes("cancel-in-progress: false") &&
        dockerWorkflow.includes("Refuse to overwrite an existing release") &&
        dockerWorkflow.includes("contents: write") &&
        dockerWorkflow.includes(
          "IMAGE_DIGEST: ${{ steps.image.outputs.digest }}",
        ) &&
        dockerWorkflow.includes(
          "Verify the exact JSR release before recording it",
        ) &&
        dockerWorkflow.includes('cd "$(mktemp -d)"') &&
        dockerWorkflow.includes(
          '"$checkout/scripts/verify-jsr-release.ts"',
        ) &&
        dockerWorkflow.includes("rekor.sigstore.dev") &&
        dockerWorkflow.includes(
          '[[ "$IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]',
        ) &&
        dockerWorkflow.includes('commit="$(git rev-parse HEAD)"') &&
        dockerWorkflow.includes("gh release create") &&
        dockerWorkflow.includes("--verify-tag") &&
        dockerWorkflow.includes("release-identity.json"),
      "Docker publication must attach the exact published index digest to the GitHub release.",
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
