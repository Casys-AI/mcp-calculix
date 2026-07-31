import { createMcpApp, defineView } from "@casys/mcp-view";
import {
  type DisplayState,
  parseStaticSolve,
  toolErrorMessage,
} from "./model.ts";
import { escapeHtml, renderDisplay } from "./render.ts";

interface ViewerState {
  display: DisplayState;
}

const resultView = defineView<ViewerState>({
  render(ctx) {
    return renderDisplay(ctx.state.display);
  },
});

async function boot(): Promise<void> {
  const root = document.getElementById("root");
  if (!root) throw new Error("The CalculiX results viewer root is missing.");
  await createMcpApp<ViewerState>({
    info: { name: "CalculiX Static Results", version: "0.2.0" },
    root,
    views: { result: resultView },
    initialView: "result",
    initialState: { display: { kind: "loading" } },
    // mcp-view registers this before connect(), preserving the initiating
    // result while the MCP Apps handshake creates the initial view.
    async onToolInput(_input, app) {
      root.setAttribute("aria-busy", "true");
      app.ctx.state.display = { kind: "loading" };
      await app.navigate("result");
    },
    async onToolResult(result, app) {
      if (result.isError) {
        app.ctx.state.display = {
          kind: "error",
          message: toolErrorMessage(result),
        };
      } else {
        try {
          app.ctx.state.display = {
            kind: "result",
            result: parseStaticSolve(result.structuredContent),
          };
        } catch (error) {
          app.ctx.state.display = {
            kind: "error",
            message: error instanceof Error
              ? error.message
              : "The static solve result could not be read.",
          };
        }
      }
      root.setAttribute("aria-busy", "false");
      await app.navigate("result");
    },
  });
}

void boot().catch((error) => {
  const root = document.getElementById("root");
  if (root) {
    root.innerHTML =
      `<section class="viewer"><div class="state error" role="alert"><h1>Viewer unavailable</h1><p>${
        escapeHtml(
          error instanceof Error
            ? error.message
            : "The viewer could not start.",
        )
      }</p></div></section>`;
    root.setAttribute("aria-busy", "false");
  }
  console.error(error);
});
