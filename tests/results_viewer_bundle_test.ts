import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";

Deno.test("viewer build fails closed without every audited split root", async () => {
  const repository = fromFileUrl(new URL("../", import.meta.url));
  const result = await new Deno.Command(Deno.execPath(), {
    cwd: repository,
    args: [
      "run",
      "--config",
      "deno.json",
      "-A",
      "src/ui/results-viewer/build.ts",
    ],
    env: {
      MCP_VIEW_LOCAL_ROOT: "",
      MCP_VIEW_CONTRACTS_LOCAL_ROOT: "",
      MCP_VIEW_COMPONENTS_LOCAL_ROOT: "",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(result.success, false);
  const error = new TextDecoder().decode(result.stderr);
  assertStringIncludes(error, "Missing MCP_VIEW_LOCAL_ROOT");
  assertStringIncludes(error, "no published compatibility fallback");
});

Deno.test("viewer sources have no monolithic 0.7 compatibility route", async () => {
  const retiredSpecifier = ["@casys/mcp-view", "0.7"].join("@");
  const files = [
    "../deno.json",
    "../src/ui/results-viewer/build.ts",
    "../src/ui/results-viewer/deno.json",
    "../src/ui/results-viewer/deno.lock",
  ];
  for (const relative of files) {
    const contents = await Deno.readTextFile(
      new URL(relative, import.meta.url),
    );
    assertEquals(
      contents.includes(retiredSpecifier),
      false,
      `${relative} must not retain the retired compatibility package`,
    );
  }

  const rootConfig = JSON.parse(
    await Deno.readTextFile(new URL("../deno.json", import.meta.url)),
  ) as { tasks?: Record<string, string> };
  assertStringIncludes(
    rootConfig.tasks?.["release:check"] ?? "",
    "check:ui:bundle",
  );
});

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

Deno.test("built CalculiX viewer contains its App-owned whole view", async () => {
  const viewer = new URL(
    "../src/ui/dist/results-viewer/index.html",
    import.meta.url,
  );
  const html = await Deno.readTextFile(viewer);

  assert(html.includes("io.casys.mcp.surface/v1"));
  assert(html.includes("io.casys.mcp.view-components/v1"));
  assert(html.includes("calculix.static-result"));
  assert(html.includes("calculix.solve-metrics"));
  assert(html.includes("calculix.mesh-summary"));
  assert(html.includes("calculix.constraints"));
  assert(html.includes("calculix.displacement-details"));
  assert(html.includes("mcp-view-semantic-element"));
  assert(html.includes("viewer.session.apply"));
  assert(html.includes("io.casys.mcp-calculix.results"));
  assert(html.includes("whole-view"));
  assert(
    html.includes(
      "io.casys.mcp-calculix.recorded-static-proof-session/1.0",
    ),
  );
  assert(html.includes("verify.run-fea-static-proof"));
  assert(html.includes("digital-thread-static-proof"));
  assert(html.includes("documentary result"));
  assertEquals(html.includes("Recorded proof"), false);
  assert(html.includes("mcp-view-card"));
  assert(html.includes("mcp-view-metrics"));
  assert(html.includes("color-scheme: light dark"));
  assert(html.includes(':root[data-theme="dark"]'));
  assert(html.includes("@media (prefers-color-scheme: dark)"));
  assert(html.includes(':root:not([data-theme="light"])'));
  assertEquals(html.includes("MCP / STATIC SOLVE"), false);
  assertEquals(html.includes('class="masthead"'), false);
});
