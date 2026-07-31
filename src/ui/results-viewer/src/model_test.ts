import { assertEquals, assertThrows } from "@std/assert";
import {
  parseStaticSolve,
  type StaticSolveResult,
  toolErrorMessage,
} from "./model.ts";
import { escapeHtml, renderStaticSolve } from "./render.ts";

const result: StaticSolveResult = {
  schemaVersion: "1.0",
  kind: "static-solve",
  mesh: {
    nodes: 9669,
    elements: 5568,
    nodesPerSelection: { FIXED: 210, LOADED: 87 },
  },
  constraints: {
    fixedSelections: ["FIXED"],
    loads: [{ selection: "LOADED", forceN: [0, 0, -500] }],
  },
  metrics: {
    maxDisplacement: {
      value: 0.0428,
      unit: "mm",
      nodeId: 26,
      vectorMm: [0.01, 0.02, -0.03],
    },
    maxVonMises: { value: 26.6, unit: "MPa", elementId: 5229 },
  },
};

Deno.test("results viewer parses exactly the static-solve v1 result", () => {
  assertEquals(parseStaticSolve(result), result);
  assertThrows(
    () => parseStaticSolve({ ...result, kind: "run" }),
    TypeError,
    "static-solve",
  );
});

Deno.test("results viewer renders physical IDs and escapes hostile selections", () => {
  const rendered = renderStaticSolve(parseStaticSolve(result));
  assertEquals(rendered.includes("Node 26"), true);
  assertEquals(rendered.includes("Element 5229"), true);
  assertEquals(rendered.includes("26.6 MPa"), true);
  const hostile = renderStaticSolve(parseStaticSolve({
    ...result,
    constraints: {
      ...result.constraints,
      fixedSelections: ["<img src=x onerror=alert(1)>"],
    },
  }));
  assertEquals(hostile.includes("<img"), false);
  assertEquals(hostile.includes("&lt;img"), true);
  assertEquals(escapeHtml("<unsafe>"), "&lt;unsafe&gt;");
  assertEquals(
    toolErrorMessage({
      content: [{ type: "text", text: "Solver unavailable" }],
    }),
    "Solver unavailable",
  );
});
