import { renderStartupFailure, startCalculixResultsApp } from "./app.ts";

const root = document.getElementById("root");
if (!root) throw new Error("The CalculiX results viewer root is missing.");

void startCalculixResultsApp(root).catch((error) => {
  root.replaceChildren(renderStartupFailure(error));
  root.setAttribute("aria-busy", "false");
  console.error(error);
});
