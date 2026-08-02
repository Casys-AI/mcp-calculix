/** @jsxImportSource preact */

import { defineComponentRegistry } from "@casys/mcp-view";
import {
  Badge,
  Card,
  definePreactComponent,
  KeyValueList,
  MetricGrid,
  type PreactSurfaceComponentProps,
  type PreactSurfaceContext,
  StateMessage,
} from "@casys/mcp-view/preact";
import type { StaticSolveResult } from "./model.ts";

export const CALCULIX_COMPONENT_KEYS = {
  solveMetrics: "calculix.solve-metrics",
  meshSummary: "calculix.mesh-summary",
  constraints: "calculix.constraints",
  displacementDetails: "calculix.displacement-details",
} as const;

type CalculixComponentProps = PreactSurfaceComponentProps<StaticSolveResult>;

const SolveMetrics = ({ data }: CalculixComponentProps) => (
  <Card
    title="Static solve metrics"
    eyebrow="Static solve"
    actions={<Badge tone="success">Solved</Badge>}
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
        {
          id: "input-source",
          label: "STEP source",
          value: data.inputArtifact.sourcePath,
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

/** Small CalculiX-owned components selectable by an agent-authored surface. */
export const CALCULIX_COMPONENT_REGISTRY = defineComponentRegistry<
  StaticSolveResult,
  PreactSurfaceContext<StaticSolveResult>
>({
  components: {
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
  defaultSurface: {
    layout: { type: "grid", columns: 2, gap: "md" },
    components: [
      {
        id: "solve-metrics",
        component: CALCULIX_COMPONENT_KEYS.solveMetrics,
      },
      {
        id: "mesh-summary",
        component: CALCULIX_COMPONENT_KEYS.meshSummary,
      },
      {
        id: "constraints",
        component: CALCULIX_COMPONENT_KEYS.constraints,
      },
      {
        id: "displacement-details",
        component: CALCULIX_COMPONENT_KEYS.displacementDetails,
      },
    ],
  },
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
