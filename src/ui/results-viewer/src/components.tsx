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
  ArtifactRow,
  Badge,
  Card,
  ElementBody,
  ElementIdent,
  ElementProvenance,
  ElementReading,
  KeyValueList,
  MetricGrid,
  SemanticElement,
  StateMessage,
} from "@casys/mcp-view-components/preact/components";
import type { StaticResultsViewData } from "./model.ts";

export const CALCULIX_COMPONENT_KEYS = {
  staticResult: "calculix.static-result",
  solveMetrics: "calculix.solve-metrics",
  meshSummary: "calculix.mesh-summary",
  constraints: "calculix.constraints",
  displacementDetails: "calculix.displacement-details",
} as const;

type CalculixComponentProps = PreactSurfaceComponentProps<
  StaticResultsViewData
>;

const StaticResult = ({ data }: CalculixComponentProps) => (
  <SemanticElement
    reference={{
      domain: "calculix",
      kind: data.kind,
      id: resultIdentity(data),
      basisFingerprint: data.inputArtifact.sha256,
    }}
    density="card"
    ident={
      <ElementIdent
        marker={resultBadge(data)}
        label={resultTitle(data)}
        detail={resultEyebrow(data)}
      />
    }
    reading={[
      <ElementReading
        key="max-displacement"
        label="Maximum displacement"
        value={formatNumber(data.metrics.maxDisplacement.value)}
        unit={data.metrics.maxDisplacement.unit}
        detail={`Node ${data.metrics.maxDisplacement.nodeId}`}
      />,
      <ElementReading
        key="max-von-mises"
        label="Maximum von Mises"
        value={formatNumber(data.metrics.maxVonMises.value)}
        unit={data.metrics.maxVonMises.unit}
        detail={`Element ${data.metrics.maxVonMises.elementId}`}
      />,
    ]}
    body={
      <ElementBody>
        {"uri" in data.inputArtifact
          ? (
            <ArtifactRow
              kind="STEP"
              label="STEP resource"
              uri={data.inputArtifact.uri}
              fingerprint={{
                algorithm: "sha256",
                digest: data.inputArtifact.sha256,
              }}
              sizeLabel={`${formatInteger(data.inputArtifact.bytes)} bytes`}
            />
          )
          : (
            <KeyValueList
              items={[{
                id: "input-source",
                label: "STEP source",
                value: data.inputArtifact.sourcePath,
              }]}
            />
          )}
      </ElementBody>
    }
    provenance={resultProvenance(data)}
  />
);

const SolveMetrics = ({ data }: CalculixComponentProps) => (
  <Card
    title={resultTitle(data)}
    eyebrow={resultEyebrow(data)}
    actions={<Badge tone={resultBadgeTone(data)}>{resultBadge(data)}</Badge>}
  >
    <MetricGrid
      items={[
        {
          id: "max-displacement",
          label: "Maximum displacement",
          value: formatNumber(data.metrics.maxDisplacement.value),
          unit: data.metrics.maxDisplacement.unit,
          detail: `Node ${data.metrics.maxDisplacement.nodeId}`,
          tone: "info",
        },
        {
          id: "max-von-mises",
          label: "Maximum von Mises",
          value: formatNumber(data.metrics.maxVonMises.value),
          unit: data.metrics.maxVonMises.unit,
          detail: `Element ${data.metrics.maxVonMises.elementId}`,
          tone: "info",
        },
      ]}
    />
  </Card>
);

const MeshSummary = ({ data }: CalculixComponentProps) => {
  const selections = Object.entries(data.mesh.nodesPerSelection);
  return (
    <Card
      title="Mesh summary"
      eyebrow="Discretization"
      actions={<Badge tone="neutral">{selections.length} selections</Badge>}
    >
      <MetricGrid
        items={[
          {
            id: "nodes",
            label: "Nodes",
            value: formatInteger(data.mesh.nodes),
          },
          {
            id: "elements",
            label: "Elements",
            value: formatInteger(data.mesh.elements),
          },
        ]}
      />
      {selections.length > 0
        ? (
          <KeyValueList
            className="calculix-selection-counts"
            items={selections.map(([selection, count], index) => ({
              id: `selection-${index}`,
              label: `${selection} nodes`,
              value: formatInteger(count),
            }))}
          />
        )
        : (
          <StateMessage title="No named selections" tone="neutral">
            This mesh does not report per-selection node counts.
          </StateMessage>
        )}
    </Card>
  );
};

const Constraints = ({ data }: CalculixComponentProps) => (
  <Card
    title="Boundary conditions"
    eyebrow="Physical inputs"
    actions={<Badge tone="info">Explicit loads</Badge>}
  >
    {data.constraints.fixedSelections.length > 0
      ? (
        <div
          aria-label="Fixed selections"
          class="mcp-view-badges calculix-fixed-selections"
        >
          {data.constraints.fixedSelections.map((selection) => (
            <Badge key={selection} tone="warning">Fixed · {selection}</Badge>
          ))}
        </div>
      )
      : (
        <StateMessage title="No fixed selection" tone="warning">
          This solve result does not declare a fixed support.
        </StateMessage>
      )}
    {data.constraints.loads.length > 0
      ? (
        <KeyValueList
          items={data.constraints.loads.map((load, index) => ({
            id: `load-${index}`,
            label: `${load.selection} load`,
            value: `[${load.forceN.map(formatNumber).join(", ")}] N`,
          }))}
        />
      )
      : (
        <StateMessage title="No nodal loads" tone="neutral">
          This solve result does not contain an explicit load vector.
        </StateMessage>
      )}
  </Card>
);

const ExtremaDetails = ({ data }: CalculixComponentProps) => (
  <Card title="Extrema details" eyebrow="Result provenance">
    <KeyValueList
      items={[
        ...provenanceItems(data),
        {
          id: "input-source",
          label: "sourcePath" in data.inputArtifact
            ? "STEP source"
            : "STEP resource",
          value: "sourcePath" in data.inputArtifact
            ? data.inputArtifact.sourcePath
            : data.inputArtifact.uri,
        },
        {
          id: "input-sha256",
          label: "STEP SHA-256",
          value: data.inputArtifact.sha256,
        },
        {
          id: "input-bytes",
          label: "STEP bytes",
          value: formatInteger(data.inputArtifact.bytes),
        },
        {
          id: "displacement-node",
          label: "Displacement node",
          value: data.metrics.maxDisplacement.nodeId,
        },
        {
          id: "displacement-vector",
          label: "Displacement vector",
          value: `[${
            data.metrics.maxDisplacement.vectorMm.map(formatNumber).join(", ")
          }] mm`,
        },
        {
          id: "stress-element",
          label: "Von Mises element",
          value: data.metrics.maxVonMises.elementId,
        },
      ]}
    />
  </Card>
);

/** Standalone default: one bounded static-result card, not a 4-pane dashboard. */
export const CALCULIX_RESULTS_SURFACE = defineComponentSurface({
  layout: { type: "stack", gap: "sm" },
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
          "Bounded static-solve identity and extrema readings, with attested STEP identity when a URI is present.",
      },
      StaticResult,
    ),
    [CALCULIX_COMPONENT_KEYS.solveMetrics]: definePreactComponent(
      {
        title: "Static solve metrics",
        description:
          "Maximum displacement and von Mises stress, including their physical IDs.",
      },
      SolveMetrics,
    ),
    [CALCULIX_COMPONENT_KEYS.meshSummary]: definePreactComponent(
      {
        title: "Mesh summary",
        description: "Node, element and named-selection mesh counts.",
      },
      MeshSummary,
    ),
    [CALCULIX_COMPONENT_KEYS.constraints]: definePreactComponent(
      {
        title: "Boundary conditions",
        description: "Fixed selections and explicit total nodal load vectors.",
      },
      Constraints,
    ),
    [CALCULIX_COMPONENT_KEYS.displacementDetails]: definePreactComponent(
      {
        title: "Extrema details",
        description:
          "Attested STEP identity plus the maximum-displacement vector and extrema node/element IDs.",
      },
      ExtremaDetails,
    ),
  },
  defaultSurface: CALCULIX_RESULTS_SURFACE,
});

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 5 }).format(
    value,
  );
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(
    value,
  );
}

function resultTitle(data: StaticResultsViewData): string {
  return data.kind === "digital-thread-static-proof"
    ? "Recorded static result metrics"
    : data.kind === "static-solve-recorded"
    ? "Recorded static-solve metrics"
    : "Static solve metrics";
}

function resultEyebrow(data: StaticResultsViewData): string {
  return data.kind === "digital-thread-static-proof"
    ? "Digital Thread · documentary result"
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

function resultBadgeTone(
  data: StaticResultsViewData,
): "neutral" | "info" {
  return data.kind === "static-solve" ? "info" : "neutral";
}

function resultIdentity(data: StaticResultsViewData): string {
  if (data.kind === "digital-thread-static-proof") return data.authority.runId;
  if (data.kind === "static-solve-recorded") return data.run.runId;
  return data.inputArtifact.sha256;
}

function resultProvenance(data: StaticResultsViewData) {
  if (data.kind === "digital-thread-static-proof") {
    return (
      <ElementProvenance
        label="Authority"
        value={data.authority.operation}
      />
    );
  }
  if (data.kind === "static-solve-recorded") {
    return (
      <ElementProvenance
        label="CalculiX run ID"
        value={data.run.runId}
      />
    );
  }
  return (
    <ElementProvenance
      label="STEP SHA-256"
      value={data.inputArtifact.sha256}
    />
  );
}

function provenanceItems(data: StaticResultsViewData): readonly {
  readonly id: string;
  readonly label: string;
  readonly value: string;
}[] {
  if (data.kind === "digital-thread-static-proof") {
    return [
      {
        id: "authority",
        label: "Authority",
        value: data.authority.operation,
      },
      {
        id: "persisted-result-sha256",
        label: "Persisted result SHA-256",
        value: data.authority.resultArtifact.fingerprint,
      },
    ];
  }
  if (data.kind === "static-solve-recorded") {
    return [
      {
        id: "run-id",
        label: "CalculiX run ID",
        value: data.run.runId,
      },
      {
        id: "request-sha256",
        label: "Request SHA-256",
        value: data.run.requestSha256,
      },
    ];
  }
  return [{
    id: "authority",
    label: "Authority",
    value: "Direct mcp-calculix result",
  }];
}
