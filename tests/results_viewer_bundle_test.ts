import { assert, assertEquals } from "@std/assert";

Deno.test("CalculiX results viewer is one syntactically valid inline module", async () => {
  const viewer = new URL(
    "../src/ui/dist/results-viewer/index.html",
    import.meta.url,
  );
  const html = await Deno.readTextFile(viewer);

  assertEquals(
    (html.match(/<!doctype html>/gi) ?? []).length,
    1,
    "the built viewer must contain exactly one HTML document",
  );

  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  assertEquals(scripts.length, 1, "the viewer must contain one inline module");
  const source = scripts[0][1];
  assert(source.trim().length > 0, "the inline module must not be empty");
  assertEquals(source.includes("BUNDLE_PLACEHOLDER"), false);
  assertEquals(source.includes("<!doctype html>"), false);

  // This catches malformed output caused by replacement-string substitutions
  // (notably `$\`` in minified dependencies) without executing the viewer.
  new Function(source);
});

Deno.test("built CalculiX viewer contains its small-component catalog", async () => {
  const viewer = new URL(
    "../src/ui/dist/results-viewer/index.html",
    import.meta.url,
  );
  const html = await Deno.readTextFile(viewer);

  assert(html.includes("io.casys.mcp.view-components/v1"));
  assert(html.includes("io.casys.mcp.surface/v1"));
  assert(html.includes("calculix.solve-metrics"));
  assert(html.includes("calculix.mesh-summary"));
  assert(html.includes("calculix.constraints"));
  assert(html.includes("calculix.displacement-details"));
  assert(html.includes("mcp-view-card"));
  assert(html.includes("mcp-view-metrics"));
  assertEquals(html.includes("MCP / STATIC SOLVE"), false);
  assertEquals(html.includes('class="masthead"'), false);
});
