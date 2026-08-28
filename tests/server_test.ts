import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  createCalculixResultsViewerFileSystem,
  createCalculixServer,
  parseCli,
} from "../server.ts";

const PROTOCOL_VERSION = "2026-07-28";
const META = {
  "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": {
    name: "mcp-calculix-test",
    // Test client identity, not the mcp-calculix package version.
    version: "0.7.0",
  },
};

const SAMPLE_RESULT = {
  schemaVersion: "2.0",
  kind: "static-solve",
  inputArtifact: {
    path: "/tmp/calculix-input-example/input.step",
    sourcePath: "/tmp/bracket.step",
    sha256: "a".repeat(64),
    bytes: 1234,
  },
  mesh: { nodes: 4, elements: 1, nodesPerSelection: { FIXED: 2, LOADED: 2 } },
  constraints: {
    fixedSelections: ["FIXED"],
    loads: [{ selection: "LOADED", forceN: [0, 0, -500] }],
  },
  metrics: {
    maxDisplacement: {
      value: 0.01,
      unit: "mm",
      nodeId: 4,
      vectorMm: [0, 0, -0.01],
    },
    maxVonMises: { value: 12.5, unit: "MPa", elementId: 1 },
  },
};

const SAMPLE_MESH_PREFLIGHT = {
  schemaVersion: "1.0",
  kind: "mesh-selection-preflight",
  inputArtifact: {
    sourcePath: "/tmp/bracket.step",
    sha256: "b".repeat(64),
    bytes: 1234,
  },
  boundsMm: { min: [-1, -2, -3], max: [4, 5, 6] },
  mesh: { nodes: 4, elements: 1 },
  selections: [{
    name: "FIXED",
    boxMm: { min: [-1, -2, -3], max: [4, 5, 6] },
    nodes: 4,
  }],
  errors: [],
};

Deno.test("CalculiX serves stateless tool and results-viewer resource contracts", async () => {
  const { app, hasResultsViewer } = createCalculixServer({
    logger: () => {},
    solveHandler: () => ({
      content: "Static solve complete.",
      structuredContent: SAMPLE_RESULT,
    }),
    meshPreflightHandler: () => ({
      content: "Mesh preflight complete.",
      structuredContent: SAMPLE_MESH_PREFLIGHT,
    }),
  });
  assertEquals(hasResultsViewer, true);
  const port = freePort();
  const http = await app.startHttp({
    port,
    hostname: "127.0.0.1",
    onListen: () => {},
  });
  const url = `http://127.0.0.1:${port}/mcp`;
  try {
    const discovered = await rpc(url, "server/discover");
    assertEquals(discovered.response.headers.get("mcp-session-id"), null);
    assertEquals(discovered.body.result.resultType, "complete");
    assertEquals(discovered.body.result.serverInfo, {
      name: "mcp-calculix",
      version: "0.8.0",
    });

    const listed = await rpc(url, "tools/list");
    const tools = listed.body.result.tools as Array<Record<string, unknown>>;
    const meshPreflight = tools.find((item) =>
      item.name === "calculix_mesh_preflight"
    );
    assert(meshPreflight);
    assertEquals(
      (meshPreflight.inputSchema as Record<string, unknown>)
        .additionalProperties,
      false,
    );
    assertEquals(
      (meshPreflight.outputSchema as Record<string, unknown>)
        .additionalProperties,
      false,
    );
    assertEquals(meshPreflight._meta, undefined);
    const tool = tools.find((item) => item.name === "calculix_solve_static");
    assert(tool);
    assertEquals(
      (tool.outputSchema as Record<string, unknown>).additionalProperties,
      false,
    );
    assertEquals(
      ((tool._meta as Record<string, unknown>).ui as Record<string, unknown>)
        .resourceUri,
      "ui://mcp-calculix/results-viewer",
    );
    const recorded = tools.find((item) =>
      item.name === "calculix_solve_static_recorded"
    );
    assert(recorded);
    assertEquals(
      ((recorded._meta as Record<string, unknown>).ui as Record<
        string,
        unknown
      >)
        .resourceUri,
      "ui://mcp-calculix/results-viewer",
    );
    const runGet = tools.find((item) => item.name === "calculix_run_get");
    assert(runGet);
    assertEquals(runGet._meta, undefined);

    const called = await rpc(url, "tools/call", {
      name: "calculix_solve_static",
      arguments: {
        step_path: "/tmp/bracket.step",
        mesh_size_mm: 4,
        material: { e_mpa: 70_000, nu: 0.33 },
        selections: [{
          name: "FIXED",
          box: { min: [0, 0, 0], max: [1, 1, 1] },
        }],
        fixed: ["FIXED"],
        loads: [{ selection: "FIXED", force_n: [0, 0, -500] }],
      },
    });
    assertEquals(called.body.result.resultType, "complete");
    assertEquals(called.body.result.structuredContent, SAMPLE_RESULT);

    const preflightCalled = await rpc(url, "tools/call", {
      name: "calculix_mesh_preflight",
      arguments: {
        step_path: "/tmp/bracket.step",
        mesh_size_mm: 4,
        selections: [{
          name: "FIXED",
          box: { min: [-1, -2, -3], max: [4, 5, 6] },
        }],
      },
    });
    assertEquals(preflightCalled.body.result.resultType, "complete");
    assertEquals(
      preflightCalled.body.result.structuredContent,
      SAMPLE_MESH_PREFLIGHT,
    );

    const resource = await rpc(url, "resources/read", {
      uri: "ui://mcp-calculix/results-viewer",
    });
    assertEquals(resource.body.result.resultType, "complete");
    const html =
      (resource.body.result.contents as Array<Record<string, unknown>>)[0]
        .text as string;
    assertEquals(html.includes("CalculiX Static Results"), true);
  } finally {
    await http.shutdown();
  }
});

Deno.test("CalculiX viewer resolves and serves the exact published JSR resource", async () => {
  const moduleUrl = "https://jsr.io/@casys/mcp-calculix/0.6.0/server.ts";
  const viewerUrl =
    "https://jsr.io/@casys/mcp-calculix/0.6.0/src/ui/dist/results-viewer/index.html";
  const html = "<!doctype html><title>Remote CalculiX results</title>";
  const { app, hasResultsViewer } = createCalculixServer({
    logger: () => {},
    viewerModuleUrl: moduleUrl,
    viewerFileSystem: {
      exists: (path) => path === viewerUrl,
      readFile: (path) => {
        assertEquals(path, viewerUrl);
        return html;
      },
    },
  });

  assertEquals(hasResultsViewer, true);
  assertEquals(
    (await app.readResourceContent("ui://mcp-calculix/results-viewer"))?.text,
    html,
  );
});

Deno.test("CalculiX remote viewer filesystem fetches HTTP resources actionably", async () => {
  const viewerUrl =
    "https://example.test/mcp-calculix/results-viewer/index.html";
  const fileSystem = createCalculixResultsViewerFileSystem((url) => {
    assertEquals(url, viewerUrl);
    return Promise.resolve(
      new Response("not published", { status: 404, statusText: "Not Found" }),
    );
  });

  assertEquals(fileSystem.exists(viewerUrl), true);
  await assertRejects(
    () => Promise.resolve(fileSystem.readFile(viewerUrl)),
    Error,
    "Unable to fetch CalculiX results viewer",
  );
});

Deno.test("CalculiX CLI selects native stdio or stateless HTTP", () => {
  assertEquals(parseCli(["--port", "3018", "--hostname=0.0.0.0"]), {
    mode: "http",
    port: 3018,
    hostname: "0.0.0.0",
  });
  assertEquals(parseCli(["--stdio"]), { mode: "stdio" });
  assertThrows(() => parseCli(["--http"]), TypeError, "Unknown argument");
  assertThrows(() => parseCli(["stdio"]), TypeError, "Unknown argument");
  assertThrows(() => parseCli(["--stdio", "--port", "3018"]), TypeError);
  assertThrows(() => parseCli(["--unknown"]), TypeError, "Unknown argument");
});

function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

async function rpc(
  url: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ response: Response; body: RpcBody }> {
  const name = method === "tools/call"
    ? params.name
    : method === "resources/read"
    ? params.uri
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
  const body = await response.json();
  if (!isRecord(body) || !isRecord(body.result)) {
    throw new TypeError("Expected a JSON-RPC response with an object result");
  }
  return { response, body: { result: body.result } };
}

interface RpcBody {
  result: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
