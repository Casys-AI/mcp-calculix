import { assertEquals, assertStringIncludes } from "@std/assert";
import { parseCalculixViewerSession } from "../src/viewer-session.ts";

const TPS03_ANCHOR =
  "calculix-isolated-result-json-b09ecd1782107093b505287f5800ac5e7f05cdaec5bbe845b4d19568bda64734";

Deno.test("the documentation session is the registered TPS03 static proof", async () => {
  const source = await Deno.readTextFile(
    new URL(
      "../docs/fixtures/tps03-recorded-static-proof-session.json",
      import.meta.url,
    ),
  );
  const session = await parseCalculixViewerSession(JSON.parse(source));
  assertEquals(session.anchor.id, TPS03_ANCHOR);
  assertEquals(session.basis.projectId, "two-piece-tablet-stand-tps03");
  assertEquals(session.basis.projectRevision, 135);
  assertEquals(session.basis.thread.revision, 17);
  assertEquals(session.provenance.kind, "digital-thread-operation");
  assertEquals(session.projection.status, "available");
  // The digital-thread result names its extrema in full; the README quotes them.
  const metrics = session.projection.status === "available"
    ? session.projection.result.metrics
    : undefined;
  assertEquals(
    metrics && "maximumDisplacement" in metrics
      ? metrics.maximumDisplacement.nodeId
      : undefined,
    167,
  );
  assertEquals(
    metrics && "maximumVonMises" in metrics
      ? metrics.maximumVonMises.elementId
      : undefined,
    3764,
  );

  const preview = await Deno.readTextFile(
    new URL("../docs/fixtures/viewer-preview.html", import.meta.url),
  );
  assertStringIncludes(preview, "tps03-recorded-static-proof-session.json");
  assertStringIncludes(preview, "the registered session, replayed");
  // Metric formatting follows this declared locale, not the capturing machine.
  assertStringIncludes(preview, 'locale: "en"');

  const readme = await Deno.readTextFile(
    new URL("../README.md", import.meta.url),
  );
  assertStringIncludes(readme, "docs/assets/calculix-results-viewer-tps03.png");
});
