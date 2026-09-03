/** @jsxImportSource preact */

import {
  defineComponentRegistry,
  defineComponentSurface,
} from "@casys/mcp-view-components";
import {
  definePreactComponent,
  type PreactSurfaceComponentProps,
  type PreactSurfaceContext,
} from "@casys/mcp-view-components/preact";
import {
  ElementBody,
  ElementIdent,
  ElementProvenance,
  MetricGrid,
  SemanticElement,
} from "@casys/mcp-view-components/preact/components";
import type { StaticResultsViewData } from "./model.ts";

export const CALCULIX_COMPONENT_KEYS = {
  staticResult: "calculix.static-result",
} as const;

type CalculixComponentProps = PreactSurfaceComponentProps<
  StaticResultsViewData
>;

const StaticResult = ({ data, context }: CalculixComponentProps) => (
  <SemanticElement
    className="calculix-result-card"
    reference={{
      domain: "calculix",
      kind: data.kind,
      id: resultIdentity(data),
      basisFingerprint: resultBasisFingerprint(data),
    }}
    density="card"
    ident={
      <ElementIdent
        marker={resultBadge(data)}
        label={resultTitle(data)}
        detail={resultEyebrow(data)}
      />
    }
    body={
      <ElementBody>
        <MetricGrid
          className="calculix-result-readings"
          items={[
            {
              id: "max-displacement",
              label: "Maximum displacement",
              value: formatNumber(
                data.metrics.maxDisplacement.value,
                context.hostContext.locale,
              ),
              unit: data.metrics.maxDisplacement.unit,
              detail: `Node ${data.metrics.maxDisplacement.nodeId}`,
            },
            {
              id: "max-von-mises",
              label: "Maximum von Mises",
              value: formatNumber(
                data.metrics.maxVonMises.value,
                context.hostContext.locale,
              ),
              unit: data.metrics.maxVonMises.unit,
              detail: `Element ${data.metrics.maxVonMises.elementId}`,
            },
          ]}
        />
      </ElementBody>
    }
    provenance={resultProvenance(data)}
  />
);

/** Standalone default: one bounded static-result card, not a 4-pane dashboard. */
export const CALCULIX_RESULTS_SURFACE = defineComponentSurface({
  layout: { type: "stack", gap: "none" },
  components: [
    {
      id: "static-result",
      component: CALCULIX_COMPONENT_KEYS.staticResult,
    },
  ],
});

/** Private registry used to render the App-owned whole view. */
export const CALCULIX_COMPONENT_REGISTRY = defineComponentRegistry<
  StaticResultsViewData,
  PreactSurfaceContext<StaticResultsViewData>
>({
  components: {
    [CALCULIX_COMPONENT_KEYS.staticResult]: definePreactComponent(
      {
        title: "Static result",
        description:
          "One recorded static-result identity with its two primary extrema and exact result provenance.",
      },
      StaticResult,
    ),
  },
  defaultSurface: CALCULIX_RESULTS_SURFACE,
});

/** The host declares the locale; the viewing machine's own setting is not it. */
function formatNumber(value: number, locale: string | undefined): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 5 }).format(
    value,
  );
}

function resultTitle(data: StaticResultsViewData): string {
  return data.kind === "digital-thread-static-proof"
    ? "Recorded static response"
    : data.kind === "static-solve-recorded"
    ? "Recorded static response"
    : "Static response";
}

function resultEyebrow(data: StaticResultsViewData): string {
  return data.kind === "digital-thread-static-proof"
    ? "Digital Thread · documentary projection"
    : data.kind === "static-solve-recorded"
    ? "CalculiX run ledger"
    : "Static solve";
}

function resultBadge(data: StaticResultsViewData): string {
  return data.kind === "digital-thread-static-proof"
    ? "Documentary"
    : data.kind === "static-solve-recorded"
    ? "Recorded"
    : "Solver result";
}

function resultIdentity(data: StaticResultsViewData): string {
  if (data.kind === "digital-thread-static-proof") {
    return data.viewerSession.anchor.id;
  }
  if (data.kind === "static-solve-recorded") return data.run.runId;
  return data.inputArtifact.sha256;
}

function resultBasisFingerprint(data: StaticResultsViewData): string {
  if (data.kind === "digital-thread-static-proof") {
    return data.viewerSession.anchor.fingerprint.slice("sha256:".length);
  }
  if (data.kind === "static-solve-recorded") {
    const artifact = data.run.artifacts.find((item) =>
      item.name === "result.json"
    );
    if (!artifact) {
      throw new TypeError("Recorded result has no result.json identity.");
    }
    return artifact.sha256;
  }
  return data.inputArtifact.sha256;
}

function resultProvenance(data: StaticResultsViewData) {
  if (data.kind === "digital-thread-static-proof") {
    return (
      <ElementProvenance
        label="Result artifact"
        value={data.viewerSession.anchor.fingerprint}
      />
    );
  }
  if (data.kind === "static-solve-recorded") {
    const artifact = data.run.artifacts.find((item) =>
      item.name === "result.json"
    );
    if (!artifact) {
      throw new TypeError("Recorded result has no result.json identity.");
    }
    return (
      <ElementProvenance
        label="Result artifact"
        value={`sha256:${artifact.sha256}`}
      />
    );
  }
  return (
    <ElementProvenance
      label="Input basis"
      value={`sha256:${data.inputArtifact.sha256}`}
    />
  );
}
