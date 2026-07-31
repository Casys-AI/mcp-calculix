import type { DisplayState, StaticSolveResult } from "./model.ts";

export function renderDisplay(display: DisplayState): string {
  if (display.kind === "loading") {
    return shell(
      "Static solve",
      '<div class="state loading"><span class="spinner" aria-hidden="true"></span><p>Receiving static solve observations…</p></div>',
    );
  }
  if (display.kind === "empty") {
    return shell(
      "Static solve",
      '<div class="state empty"><h2>No result data</h2><p>The tool completed without a static-solve result.</p></div>',
    );
  }
  if (display.kind === "error") {
    return shell(
      "Static solve",
      '<div class="state error" role="alert"><h2>Unable to display result</h2><p>' +
        escapeHtml(display.message) + "</p></div>",
    );
  }
  return renderStaticSolve(display.result);
}

export function renderStaticSolve(result: StaticSolveResult): string {
  const displacement = result.metrics.maxDisplacement;
  const stress = result.metrics.maxVonMises;
  return shell(
    "Static solve observations",
    `<section class="metric-pair" aria-label="Physical metrics">
      ${
      metric(
        "Maximum displacement",
        format(displacement.value, displacement.unit),
        `Node ${displacement.nodeId}`,
      )
    }
      ${
      metric(
        "Maximum von Mises",
        format(stress.value, stress.unit),
        `Element ${stress.elementId}`,
      )
    }
    </section>
    <section class="panel"><h2>Mesh</h2><dl class="grid">
      ${fact("Nodes", result.mesh.nodes.toLocaleString())}
      ${fact("Elements", result.mesh.elements.toLocaleString())}
      ${
      Object.entries(result.mesh.nodesPerSelection).map(([name, count]) =>
        fact(name, `${count.toLocaleString()} selected nodes`)
      ).join("")
    }
    </dl></section>
    <section class="panel"><h2>Constraints</h2>
      <p class="muted">Fixed selections: ${
      escapeHtml(result.constraints.fixedSelections.join(", ") || "none")
    }</p>
      ${
      result.constraints.loads.length
        ? `<div class="loads">${
          result.constraints.loads.map((load) =>
            `<article><strong>${escapeHtml(load.selection)}</strong><code>[${
              load.forceN.map((value) => format(value, "N")).join(", ")
            }]</code></article>`
          ).join("")
        }</div>`
        : '<p class="muted">No nodal loads were reported.</p>'
    }
    </section>
    <section class="panel"><h2>Maximum displacement vector</h2><code>[${
      displacement.vectorMm.map((value) => format(value, "mm")).join(", ")
    }]</code></section>`,
  );
}

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}

function shell(title: string, content: string): string {
  return `<section class="viewer" aria-label="CalculiX static solve"><header class="masthead"><div><p class="kicker">MCP / STATIC SOLVE</p><h1>${
    escapeHtml(title)
  }</h1></div><span class="readout">OBSERVATIONS</span></header>${content}</section>`;
}

function metric(title: string, value: string, identifier: string): string {
  return `<article class="metric"><p>${escapeHtml(title)}</p><strong>${
    escapeHtml(value)
  }</strong><small>${escapeHtml(identifier)}</small></article>`;
}

function fact(label: string, value: string): string {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${
    escapeHtml(value)
  }</dd></div>`;
}

function format(value: number, unit: string): string {
  return `${
    new Intl.NumberFormat(undefined, { maximumFractionDigits: 5 }).format(value)
  } ${unit}`;
}
