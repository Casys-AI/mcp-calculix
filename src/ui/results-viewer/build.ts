import { dirname, fromFileUrl, join, resolve, toFileUrl } from "@std/path";

const here = dirname(fromFileUrl(import.meta.url));
const localMcpViewRoot = Deno.env.get("MCP_VIEW_LOCAL_ROOT");
const mcpViewModule = localMcpViewRoot
  ? toFileUrl(resolve(Deno.cwd(), localMcpViewRoot, "mod.ts")).href
  : Deno.env.get("MCP_VIEW_MODULE") ?? "jsr:@casys/mcp-view@0.7.0";
const mcpViewPreactModule = localMcpViewRoot
  ? toFileUrl(resolve(Deno.cwd(), localMcpViewRoot, "preact.ts")).href
  : Deno.env.get("MCP_VIEW_PREACT_MODULE") ??
    "jsr:@casys/mcp-view@0.7.0/preact";
const temporaryDirectory = await Deno.makeTempDir({
  prefix: "mcp-view-result-viewer-",
});
const importMap = join(temporaryDirectory, "import-map.json");
const bundlePath = join(temporaryDirectory, "result-viewer.js");

try {
  await Deno.writeTextFile(
    importMap,
    JSON.stringify({
      minimumDependencyAge: {
        age: "P1D",
        exclude: ["jsr:@casys/mcp-view"],
      },
      compilerOptions: {
        jsx: "react-jsx",
        jsxImportSource: "preact",
        lib: [
          "deno.ns",
          "deno.window",
          "dom",
          "dom.iterable",
          "dom.asynciterable",
          "esnext",
        ],
      },
      imports: {
        "@casys/mcp-view": mcpViewModule,
        "@casys/mcp-view/preact": mcpViewPreactModule,
        "@modelcontextprotocol/ext-apps":
          "npm:@modelcontextprotocol/ext-apps@^1.7.4",
        "@modelcontextprotocol/sdk": "npm:@modelcontextprotocol/sdk@^1.29.0",
        "@modelcontextprotocol/sdk/types.js":
          "npm:@modelcontextprotocol/sdk@^1.29.0/types.js",
        "preact": "npm:preact@^10.28.3",
        "preact/jsx-runtime": "npm:preact@^10.28.3/jsx-runtime",
      },
    }),
  );
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "bundle",
      "--config",
      importMap,
      "--check",
      "--platform=browser",
      "--minify",
      join(here, "src", "main.ts"),
      "--output",
      bundlePath,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  const template = await Deno.readTextFile(join(here, "index.html"));
  const css = await Deno.readTextFile(join(here, "src", "styles.css"));
  const js = await Deno.readTextFile(bundlePath);
  const html = template
    // `String.replace` treats `$&`, `$\`` and friends in a replacement string
    // as substitution tokens. A minified third-party bundle can legitimately
    // contain those sequences, so return the generated asset from callbacks
    // rather than passing it as a replacement string.
    .replace("/* STYLES_PLACEHOLDER */", () => css)
    .replace("/* BUNDLE_PLACEHOLDER */", () => js)
    // Third-party bundled code occasionally carries trailing spaces inside
    // template literals. They are not meaningful in a standalone resource and
    // would make the checked-in artifact fail git's whitespace check.
    .replaceAll(/[ \t]+(?=\r?\n)/g, "");
  const output = join(here, "..", "dist", "results-viewer", "index.html");
  await Deno.mkdir(dirname(output), { recursive: true });
  await Deno.writeTextFile(output, html);
  console.log("[result-viewer] wrote " + output);
} finally {
  await Deno.remove(temporaryDirectory, { recursive: true });
}
