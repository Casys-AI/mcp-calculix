import type { DisplayState } from "./model.ts";

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
  return shell(
    "Static solve observations",
    '<div class="state"><p>Preparing the component surface…</p></div>',
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
