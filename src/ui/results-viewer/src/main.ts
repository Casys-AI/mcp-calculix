import { startPreactSurfaceApp } from "@casys/mcp-view/preact";
import { CALCULIX_COMPONENT_REGISTRY } from "./components.tsx";
import { parseStaticSolve, type StaticSolveResult } from "./model.ts";

const root = document.getElementById("root");
if (!root) throw new Error("The CalculiX results viewer root is missing.");

void startPreactSurfaceApp<StaticSolveResult>({
  root,
  info: { name: "CalculiX Static Results", version: "0.8.0" },
  registry: CALCULIX_COMPONENT_REGISTRY,
  surfaceClassName: "calculix-component-surface",
  loadingLabel: "Receiving static solve observations…",
  emptyLabel: "CalculiX returned no valid static-solve result.",
  validate: (value): value is StaticSolveResult => {
    try {
      parseStaticSolve(value);
      return true;
    } catch {
      return false;
    }
  },
}).catch((error) => {
  const state = document.createElement("div");
  state.className = "mcp-view-state";
  state.dataset.tone = "danger";
  state.setAttribute("role", "alert");
  const title = document.createElement("strong");
  title.textContent = "CalculiX viewer unavailable";
  const detail = document.createElement("div");
  detail.className = "mcp-view-state-detail";
  detail.textContent = error instanceof Error
    ? error.message
    : "The viewer could not start.";
  state.append(title, detail);
  root.replaceChildren(state);
  root.setAttribute("aria-busy", "false");
  console.error(error);
});
