import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  advertisedComponentCatalog,
  mountComponentSurface,
} from "@casys/mcp-view";
import {
  CALCULIX_COMPONENT_KEYS,
  CALCULIX_COMPONENT_REGISTRY,
} from "./components.ts";
import {
  parseStaticSolve,
  type StaticSolveResult,
  toolErrorMessage,
} from "./model.ts";
import { escapeHtml } from "./render.ts";

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

Deno.test("results viewer keeps safe error fallbacks", () => {
  assertEquals(escapeHtml("<unsafe>"), "&lt;unsafe&gt;");
  assertEquals(
    toolErrorMessage({
      content: [{ type: "text", text: "Solver unavailable" }],
    }),
    "Solver unavailable",
  );
});

Deno.test("results viewer advertises four small components and a complete default surface", () => {
  const catalog = advertisedComponentCatalog(CALCULIX_COMPONENT_REGISTRY);
  assertEquals(
    Object.keys(catalog.components),
    Object.values(CALCULIX_COMPONENT_KEYS),
  );
  assertEquals(catalog.defaultSurface, {
    layout: { type: "grid", columns: 2, gap: "md" },
    components: [
      { id: "solve-metrics", component: "calculix.solve-metrics" },
      { id: "mesh-summary", component: "calculix.mesh-summary" },
      { id: "constraints", component: "calculix.constraints" },
      {
        id: "displacement-details",
        component: "calculix.displacement-details",
      },
    ],
  });
});

Deno.test({
  name: "CalculiX components mount real static-solve data as safe semantic DOM",
  permissions: { read: true, env: true, run: true },
  async fn() {
    const documentModule = await import("linkedom");
    const dom = documentModule.parseHTML(
      "<html><body><div id=root></div></body></html>",
    );
    const previousDocument = globalThis.document;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: dom.document,
    });
    try {
      const root = dom.document.getElementById(
        "root",
      ) as unknown as HTMLElement;
      const mounted = await mountComponentSurface({
        root,
        registry: CALCULIX_COMPONENT_REGISTRY,
        data: {
          ...result,
          constraints: {
            ...result.constraints,
            fixedSelections: ["<img src=x onerror=alert(1)>"],
          },
        },
        appContext: {},
        hostContext: {},
      });

      assertEquals(root.querySelectorAll("[data-component]").length, 4);
      assertStringIncludes(root.textContent, "0.0428");
      assertStringIncludes(root.textContent, "26.6");
      assertStringIncludes(root.textContent, "Node 26");
      assertStringIncludes(root.textContent, "Element 5229");
      assertStringIncludes(root.textContent, "Nodes9669");
      assertStringIncludes(root.textContent, "[0, 0, -500] N");
      assertEquals(root.innerHTML.includes("<img"), false);
      assertStringIncludes(root.textContent, "<img src=x onerror=alert(1)>");

      await mounted.dispose();
      assertEquals(root.textContent, "");
    } finally {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: previousDocument,
      });
    }
  },
});

Deno.test({
  name: "an agent can request a truthful subset without size modes",
  permissions: { read: true, env: true, run: true },
  async fn() {
    const documentModule = await import("linkedom");
    const dom = documentModule.parseHTML(
      "<html><body><div id=root></div></body></html>",
    );
    const previousDocument = globalThis.document;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: dom.document,
    });
    try {
      const root = dom.document.getElementById(
        "root",
      ) as unknown as HTMLElement;
      const mounted = await mountComponentSurface({
        root,
        registry: CALCULIX_COMPONENT_REGISTRY,
        data: result,
        appContext: {},
        hostContext: {},
        surface: {
          layout: { type: "stack", gap: "sm" },
          components: [
            {
              id: "metrics",
              component: CALCULIX_COMPONENT_KEYS.solveMetrics,
            },
          ],
        },
      });
      assertEquals(
        [...root.querySelectorAll("[data-component]")].map((node) =>
          node.getAttribute("data-component")
        ),
        [CALCULIX_COMPONENT_KEYS.solveMetrics],
      );
      await mounted.dispose();
    } finally {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: previousDocument,
      });
    }
  },
});
