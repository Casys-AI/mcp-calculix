/** Native stdio wire coverage against the real server entrypoint. */
import { assert, assertEquals } from "@std/assert";
import { TextLineStream } from "@std/streams/text-line-stream";

const VIEWER_URI = "ui://mcp-calculix/results-viewer";
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_INFO_KEY = "io.modelcontextprotocol/clientInfo";
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";
const PACKAGE_VERSION = (JSON.parse(
  await Deno.readTextFile(new URL("../deno.json", import.meta.url)),
) as { version: string }).version;

async function collectResponses(
  stdout: ReadableStream<Uint8Array>,
  expected: number,
  timeoutMs: number,
): Promise<Record<string, unknown>[]> {
  const responses: Record<string, unknown>[] = [];
  const lines = stdout
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new TextLineStream());
  const reader = lines.getReader();
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    while (responses.length < expected) {
      const { value, done } = await readBeforeTimeout(reader, timeout);
      if (done) break;
      if (value.trim() === "") continue;
      responses.push(JSON.parse(value) as Record<string, unknown>);
    }
  } finally {
    reader.releaseLock();
  }
  return responses;
}

function readBeforeTimeout(
  reader: ReadableStreamDefaultReader<string>,
  timeout: AbortSignal,
): Promise<ReadableStreamReadResult<string>> {
  return new Promise((resolve, reject) => {
    const rejectTimeout = () =>
      reject(new Error("Timed out waiting for native stdio response."));
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

function responseById(
  responses: Record<string, unknown>[],
  id: number,
): Record<string, unknown> {
  const response = responses.find((candidate) => candidate.id === id);
  assert(response, `missing JSON-RPC response id ${id}`);
  assert(response.result, `response id ${id} returned JSON-RPC error`);
  return response.result as Record<string, unknown>;
}

Deno.test("native stdio serves a modern first-request discovery envelope", async () => {
  const runsDirectory = await Deno.makeTempDir({
    prefix: "mcp-calculix-modern-stdio-",
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
            [PROTOCOL_VERSION_KEY]: MODERN_PROTOCOL_VERSION,
            [CLIENT_INFO_KEY]: {
              name: "native-stdio-modern-test",
              version: "0",
            },
            [CLIENT_CAPABILITIES_KEY]: {},
          },
        },
      }) + "\n",
    ));

    const responses = await collectResponses(server.stdout, 1, 30_000);
    assertEquals(responses.length, 1);
    const discovered = responseById(responses, 1);
    assertEquals(discovered.resultType, "complete");
    assertEquals(discovered.supportedVersions, [MODERN_PROTOCOL_VERSION]);
    assertEquals(
      (discovered._meta as Record<string, unknown>)[SERVER_INFO_KEY],
      { name: "mcp-calculix", version: PACKAGE_VERSION },
    );
  } finally {
    await writer.close().catch(() => undefined);
    try {
      server.kill("SIGTERM");
    } catch {
      // The server may have exited after its stdin closed.
    }
    await server.status;
    await Deno.remove(runsDirectory, { recursive: true });
  }
});

Deno.test(
  "native stdio accepts legacy initialize, executes run_get, and serves viewer resources",
  async () => {
    const runsDirectory = await Deno.makeTempDir({
      prefix: "mcp-calculix-native-stdio-",
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
    const send = (message: Record<string, unknown>) =>
      writer.write(new TextEncoder().encode(JSON.stringify(message) + "\n"));

    try {
      await send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "native-stdio-test", version: "0" },
        },
      });
      await send({ jsonrpc: "2.0", method: "notifications/initialized" });
      await send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });
      await send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "calculix_run_get",
          arguments: { request_id: "native-stdio-no-record" },
        },
      });
      await send({
        jsonrpc: "2.0",
        id: 4,
        method: "resources/list",
        params: {},
      });
      await send({
        jsonrpc: "2.0",
        id: 5,
        method: "resources/read",
        params: { uri: VIEWER_URI },
      });
      await send({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "calculix_solve_static",
          arguments: {
            step_path: runsDirectory,
            mesh_size_mm: 4,
            material: { e_mpa: 70_000, nu: 0.33 },
            selections: [
              {
                name: "FIXED",
                box: { min: [0, 0, 0], max: [1, 1, 1] },
              },
              {
                name: "LOADED",
                box: { min: [1, 0, 0], max: [2, 1, 1] },
              },
            ],
            fixed: ["FIXED"],
            loads: [{ selection: "LOADED", force_n: [0, 0, -500] }],
          },
        },
      });

      const responses = await collectResponses(server.stdout, 6, 30_000);
      assertEquals(responses.length, 6, "expected six native stdio responses");

      const initialized = responseById(responses, 1);
      assertEquals(initialized.protocolVersion, "2025-06-18");
      assertEquals(
        (initialized.serverInfo as Record<string, unknown>).name,
        "mcp-calculix",
      );

      const tools = responseById(responses, 2).tools as Array<
        Record<string, unknown>
      >;
      assert(
        tools.some((tool) => tool.name === "calculix_mesh_preflight"),
        "the native server must register the mesh-only preflight",
      );

      const runGet = responseById(responses, 3);
      assertEquals(
        (runGet.structuredContent as Record<string, unknown>).status,
        "not_found",
      );
      assertEquals(runGet.isError, undefined);

      const listed = responseById(responses, 4);
      const viewer = (listed.resources as Array<Record<string, unknown>>).find(
        (resource) => resource.uri === VIEWER_URI,
      );
      assert(viewer, "the native resource lifecycle must list the viewer");

      const read = responseById(responses, 5);
      const content = (read.contents as Array<Record<string, unknown>>)[0];
      assertEquals(content.uri, VIEWER_URI);
      assertEquals(
        (content.text as string).includes("CalculiX Static Results"),
        true,
      );

      const boundedError = responseById(responses, 6);
      assertEquals(boundedError.isError, true);
      const errorContent = boundedError.content as Array<
        Record<string, unknown>
      >;
      const payload = JSON.parse(String(errorContent[0].text));
      assertEquals(payload.code, "resource_limit");
      assertEquals(payload.context.resource, "step_bytes");
      assertEquals(payload.context.reason, "non_regular_file");
      assertEquals(payload.context.tool, "calculix_solve_static");
      assertEquals(typeof payload.recovery, "string");
    } finally {
      await writer.close().catch(() => undefined);
      try {
        server.kill("SIGTERM");
      } catch {
        // The server may have exited after its stdin closed.
      }
      await server.status;
      await Deno.remove(runsDirectory, { recursive: true });
    }
  },
);
