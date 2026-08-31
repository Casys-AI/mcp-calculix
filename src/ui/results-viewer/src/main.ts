import { renderStateMessage, startCalculixResultsApp } from "./app.ts";

const root = document.getElementById("root");
if (!root) throw new Error("The CalculiX results viewer root is missing.");

void startCalculixResultsApp(root).catch((error) => {
  root.replaceChildren(renderStateMessage(
    error instanceof Error ? error.message : "The viewer could not start.",
    "danger",
    "CalculiX viewer unavailable",
  ));
  root.setAttribute("aria-busy", "false");
  console.error(error);
});
