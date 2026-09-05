/** @jsxImportSource preact */

import {
  defineComponentRegistry,
  defineComponentSurface,
  type Translator,
} from "@casys/mcp-view-components";
import {
  definePreactComponent,
  type PreactSurfaceComponentProps,
  type PreactSurfaceContext,
} from "@casys/mcp-view-components/preact";
import {
  ElementIdent,
  ElementProvenance,
  ElementSection,
  FocusedView,
  InlineCode,
  KeyValueList,
  MetricGrid,
} from "@casys/mcp-view-components/preact/components";
import type { ComponentChild } from "preact";
import {
  type CalculixMessageKey,
  calculixMessages,
  formatCount,
  formatNumber,
} from "./i18n.ts";
import type { StaticResultsViewData } from "./model.ts";

export const CALCULIX_COMPONENT_KEYS = {
  staticResult: "calculix.static-result",
} as const;

type CalculixComponentProps = PreactSurfaceComponentProps<
  StaticResultsViewData
>;

type CalculixTranslator = Translator<CalculixMessageKey>;

interface Fact {
  readonly id: string;
  readonly label: string;
  readonly value: ComponentChild;
}

const StaticResult = ({ data, context }: CalculixComponentProps) => {
  const locale = context.hostContext.locale;
  const t = calculixMessages(locale);
  const boundary = boundaryFacts(data, locale, t);
  return (
    <FocusedView
      className="calculix-result-view"
      label={resultTitle(data, t)}
      hostContext={context.hostContext}
      status={
        <ElementIdent
          marker={resultBadge(data)}
          label={resultTitle(data, t)}
          detail={resultEyebrow(data)}
        />
      }
      primary={
        <MetricGrid
          className="calculix-result-readings"
          items={[
            {
              id: "max-displacement",
              label: t("maxDisplacement"),
              value: formatNumber(
                data.metrics.maxDisplacement.value,
                locale,
              ),
              unit: data.metrics.maxDisplacement.unit,
              detail: t("node", { id: data.metrics.maxDisplacement.nodeId }),
            },
            {
              id: "max-von-mises",
              label: t("maxVonMises"),
              value: formatNumber(data.metrics.maxVonMises.value, locale),
              unit: data.metrics.maxVonMises.unit,
              detail: t("element", { id: data.metrics.maxVonMises.elementId }),
            },
          ]}
        />
      }
      detailsLabel={t("technicalDetails")}
      details={
        <>
          <ElementSection title={t("model")}>
            <Facts items={modelFacts(data, locale, t)} />
          </ElementSection>
          {boundary.length > 0 && (
            <ElementSection title={t("boundaryConditions")}>
              <Facts items={boundary} />
            </ElementSection>
          )}
          {resultProvenance(data, t)}
        </>
      }
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

/** What was meshed: the whole model, then every named selection with its node count. */
function modelFacts(
  data: StaticResultsViewData,
  locale: string | undefined,
  t: CalculixTranslator,
): Fact[] {
  const { mesh } = data;
  return [
    { id: "nodes", label: t("nodes"), value: formatCount(mesh.nodes, locale) },
    {
      id: "elements",
      label: t("elements"),
      value: formatCount(mesh.elements, locale),
    },
    ...Object.entries(mesh.nodesPerSelection).map(([selection, nodes]) => ({
      id: `selection-${selection}`,
      label: t("selection"),
      value: (
        <>
          <InlineCode>{selection}</InlineCode> · {t("selectionNodes", {
            count: formatCount(nodes, locale),
          })}
        </>
      ),
    })),
  ];
}

/** Fixed selections and every applied force vector, as the deck stated them. */
function boundaryFacts(
  data: StaticResultsViewData,
  locale: string | undefined,
  t: CalculixTranslator,
): Fact[] {
  const { constraints } = data;
  return [
    ...constraints.fixedSelections.map((selection) => ({
      id: `fixed-${selection}`,
      label: t("fixed"),
      value: <InlineCode>{selection}</InlineCode>,
    })),
    // The solver accepts repeated load selections, so the index keeps ids unique.
    ...constraints.loads.map((load, index) => ({
      id: `load-${index + 1}-${load.selection}`,
      label: t("load"),
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

function resultTitle(
  data: StaticResultsViewData,
  t: CalculixTranslator,
): string {
  return data.kind === "static-solve"
    ? t("staticResponse")
    : t("recordedStaticResponse");
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

function resultProvenance(
  data: StaticResultsViewData,
  t: CalculixTranslator,
) {
  if (data.kind === "digital-thread-static-proof") {
    return (
      <ElementProvenance
        label={t("resultArtifact")}
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
        label={t("resultArtifact")}
        value={`sha256:${artifact.sha256}`}
      />
    );
  }
  return (
    <ElementProvenance
      label={t("inputBasis")}
      value={`sha256:${data.inputArtifact.sha256}`}
    />
  );
}
