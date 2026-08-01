import {
  defineComponentRegistry,
  defineKeyValueComponent,
  defineMetricGridComponent,
} from "@casys/mcp-view";
import type { StaticSolveResult } from "./model.ts";

export const CALCULIX_COMPONENT_KEYS = {
  solveMetrics: "calculix.solve-metrics",
  meshSummary: "calculix.mesh-summary",
  constraints: "calculix.constraints",
  displacementDetails: "calculix.displacement-details",
} as const;

/** Small CalculiX-owned components selectable by an agent-authored surface. */
export const CALCULIX_COMPONENT_REGISTRY = defineComponentRegistry<
  StaticSolveResult,
  unknown
>({
  components: {
    [CALCULIX_COMPONENT_KEYS.solveMetrics]: defineMetricGridComponent({
      title: "Static solve metrics",
      description:
        "Maximum displacement and von Mises stress, including their physical IDs.",
      select: (result: StaticSolveResult) => [
        {
          id: "max-displacement",
          label: "Maximum displacement",
          value: formatNumber(result.metrics.maxDisplacement.value),
          unit: result.metrics.maxDisplacement.unit,
          detail: `Node ${result.metrics.maxDisplacement.nodeId}`,
        },
        {
          id: "max-von-mises",
          label: "Maximum von Mises",
          value: formatNumber(result.metrics.maxVonMises.value),
          unit: result.metrics.maxVonMises.unit,
          detail: `Element ${result.metrics.maxVonMises.elementId}`,
        },
      ],
    }),
    [CALCULIX_COMPONENT_KEYS.meshSummary]: defineKeyValueComponent({
      title: "Mesh summary",
      description: "Node, element and named-selection mesh counts.",
      select: (result: StaticSolveResult) => [
        { key: "nodes", label: "Nodes", value: result.mesh.nodes },
        { key: "elements", label: "Elements", value: result.mesh.elements },
        ...Object.entries(result.mesh.nodesPerSelection).map(
          ([selection, count], index) => ({
            key: `selection-${index}`,
            label: `${selection} nodes`,
            value: count,
          }),
        ),
      ],
    }),
    [CALCULIX_COMPONENT_KEYS.constraints]: defineKeyValueComponent({
      title: "Boundary conditions",
      description: "Fixed selections and explicit total nodal load vectors.",
      select: (result: StaticSolveResult) => [
        {
          key: "fixed-selections",
          label: "Fixed selections",
          value: result.constraints.fixedSelections.join(", ") || "none",
        },
        ...result.constraints.loads.map((load, index) => ({
          key: `load-${index}`,
          label: `${load.selection} load`,
          value: `[${load.forceN.map(formatNumber).join(", ")}] N`,
        })),
      ],
    }),
    [CALCULIX_COMPONENT_KEYS.displacementDetails]: defineKeyValueComponent({
      title: "Extrema details",
      description:
        "Maximum-displacement vector and the extrema node/element IDs.",
      select: (result: StaticSolveResult) => [
        {
          key: "displacement-node",
          label: "Displacement node",
          value: result.metrics.maxDisplacement.nodeId,
        },
        {
          key: "displacement-vector",
          label: "Displacement vector",
          value: `[${
            result.metrics.maxDisplacement.vectorMm.map(formatNumber).join(", ")
          }] mm`,
        },
        {
          key: "stress-element",
          label: "Von Mises element",
          value: result.metrics.maxVonMises.elementId,
        },
      ],
    }),
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
