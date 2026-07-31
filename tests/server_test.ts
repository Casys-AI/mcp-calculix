import { assert, assertEquals } from "@std/assert";
import { createCalculixServer } from "../server.ts";

const PROTOCOL_VERSION = "2026-07-28";
const META = {
  "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": {
    name: "mcp-calculix-test",
    version: "0.2.0",
  },
};

const SAMPLE_RESULT = {
  schemaVersion: "1.0",
  kind: "static-solve",
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

Deno.test("CalculiX serves stateless tool and results-viewer resource contracts", async () => {
  const { app, hasResultsViewer } = createCalculixServer({
    logger: () => {},
    solveHandler: () => ({
      content: "Static solve complete.",
      structuredContent: SAMPLE_RESULT,
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
      version: "0.2.0",
    });

    const listed = await rpc(url, "tools/list");
    const tool = (listed.body.result.tools as Array<Record<string, unknown>>)
      .find((item) => item.name === "calculix_solve_static");
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
