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
  ElementSection,
  InlineCode,
  KeyValueList,
  MetricGrid,
  SemanticElement,
} from "@casys/mcp-view-components/preact/components";
import type { ComponentChild } from "preact";
import type { StaticResultsViewData } from "./model.ts";

export const CALCULIX_COMPONENT_KEYS = {
  staticResult: "calculix.static-result",
} as const;

type CalculixComponentProps = PreactSurfaceComponentProps<
  StaticResultsViewData
>;

interface Fact {
  readonly id: string;
  readonly label: string;
  readonly value: ComponentChild;
}

const StaticResult = ({ data, context }: CalculixComponentProps) => {
  const boundary = boundaryFacts(data, context.hostContext.locale);
  return (
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
          <ElementSection title="Model">
            <Facts items={modelFacts(data, context.hostContext.locale)} />
          </ElementSection>
          {boundary.length > 0 && (
            <ElementSection title="Boundary conditions">
              <Facts items={boundary} />
            </ElementSection>
          )}
        </ElementBody>
      }
      provenance={resultProvenance(data)}
    />
  );
};

/** Reader-worded facts in two columns; the inspector layout is for field dumps. */
function Facts({ items }: { readonly items: readonly Fact[] }) {
  return <KeyValueList layout="facts" items={items} />;
}

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

function formatCount(value: number, locale: string | undefined): string {
  return new Intl.NumberFormat(locale).format(value);
}

/** What was meshed: the whole model, then every named selection with its node count. */
function modelFacts(
  data: StaticResultsViewData,
  locale: string | undefined,
): Fact[] {
  const { mesh } = data;
  return [
    { id: "nodes", label: "Nodes", value: formatCount(mesh.nodes, locale) },
    {
      id: "elements",
      label: "Elements",
      value: formatCount(mesh.elements, locale),
    },
    ...Object.entries(mesh.nodesPerSelection).map(([selection, nodes]) => ({
      id: `selection-${selection}`,
      label: "Selection",
      value: (
        <>
          <InlineCode>{selection}</InlineCode> · {formatCount(nodes, locale)}
          {" "}
          nodes
        </>
      ),
    })),
  ];
}

/** Fixed selections and every applied force vector, as the deck stated them. */
function boundaryFacts(
  data: StaticResultsViewData,
  locale: string | undefined,
): Fact[] {
  const { constraints } = data;
  return [
    ...constraints.fixedSelections.map((selection) => ({
      id: `fixed-${selection}`,
      label: "Fixed",
      value: <InlineCode>{selection}</InlineCode>,
    })),
    // The solver accepts repeated load selections, so the index keeps ids unique.
    ...constraints.loads.map((load, index) => ({
      id: `load-${index + 1}-${load.selection}`,
      label: "Load",
      value: (
        <>
          <InlineCode>{load.selection}</InlineCode> · [
          {load.forceN.map((component) => formatNumber(component, locale))
            .join(", ")}
          ] N
        </>
      ),
    })),
  ];
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
