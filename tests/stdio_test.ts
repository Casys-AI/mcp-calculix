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
        method: "tools/call",
        params: {
          name: "calculix_run_get",
          arguments: { request_id: "native-stdio-no-record" },
        },
      });
      await send({
        jsonrpc: "2.0",
        id: 3,
        method: "resources/list",
        params: {},
      });
      await send({
        jsonrpc: "2.0",
        id: 4,
        method: "resources/read",
        params: { uri: VIEWER_URI },
      });

      const responses = await collectResponses(server.stdout, 4, 30_000);
      assertEquals(responses.length, 4, "expected four native stdio responses");

      const initialized = responseById(responses, 1);
      assertEquals(initialized.protocolVersion, "2025-06-18");
      assertEquals(
        (initialized.serverInfo as Record<string, unknown>).name,
        "mcp-calculix",
      );

      const runGet = responseById(responses, 2);
      assertEquals(
        (runGet.structuredContent as Record<string, unknown>).status,
        "not_found",
      );
      assertEquals(runGet.isError, undefined);

      const listed = responseById(responses, 3);
      const viewer = (listed.resources as Array<Record<string, unknown>>).find(
        (resource) => resource.uri === VIEWER_URI,
      );
      assert(viewer, "the native resource lifecycle must list the viewer");

      const read = responseById(responses, 4);
      const content = (read.contents as Array<Record<string, unknown>>)[0];
      assertEquals(content.uri, VIEWER_URI);
      assertEquals(
        (content.text as string).includes("CalculiX Static Results"),
        true,
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
  },
);
