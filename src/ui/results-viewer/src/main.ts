import {
  advertisedComponentCatalog,
  type AppContext,
  createMcpApp,
  defineView,
  mountComponentSurface,
  type MountedComponentSurface,
} from "@casys/mcp-view";
import {
  type DisplayState,
  parseStaticSolve,
  toolErrorMessage,
} from "./model.ts";
import { escapeHtml, renderDisplay } from "./render.ts";
import { CALCULIX_COMPONENT_REGISTRY } from "./components.ts";

interface ViewerState {
  display: DisplayState;
}

const statusView = defineView<ViewerState>({
  render(ctx) {
    return renderDisplay(ctx.state.display);
  },
});

const surfaceView = createSurfaceView();

async function boot(): Promise<void> {
  const root = document.getElementById("root");
  if (!root) throw new Error("The CalculiX results viewer root is missing.");
  await createMcpApp<ViewerState>({
    info: { name: "CalculiX Static Results", version: "0.2.1" },
    root,
    views: { status: statusView, surface: surfaceView },
    initialView: "status",
    initialState: { display: { kind: "loading" } },
    componentCatalog: advertisedComponentCatalog(CALCULIX_COMPONENT_REGISTRY),
    // mcp-view registers this before connect(), preserving the initiating
    // result while the MCP Apps handshake creates the initial view.
    async onToolInput(_input, app) {
      root.setAttribute("aria-busy", "true");
      app.ctx.state.display = { kind: "loading" };
      await app.navigate("status");
    },
    async onToolResult(result, app) {
      if (result.isError) {
        app.ctx.state.display = {
          kind: "error",
          message: toolErrorMessage(result),
        };
        root.setAttribute("aria-busy", "false");
        await app.navigate("status");
        return;
      } else {
        try {
          const staticSolve = parseStaticSolve(result.structuredContent);
          app.ctx.state.display = {
            kind: "result",
            result: staticSolve,
          };
          root.setAttribute("aria-busy", "false");
          await app.navigate("surface", staticSolve);
          return;
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
      await app.navigate("status");
    },
  });
}

function createSurfaceView() {
  let cleanup: (() => Promise<void>) | undefined;
  return defineView<
    ViewerState,
    ReturnType<typeof parseStaticSolve>,
    ReturnType<typeof parseStaticSolve>
  >({
    onEnter(_ctx, result) {
      return result;
    },
    render(ctx, result) {
      const viewer = document.createElement("section");
      viewer.className = "viewer";
      viewer.setAttribute("aria-label", "CalculiX static solve");

      const header = document.createElement("header");
      header.className = "masthead";
      const heading = document.createElement("div");
      const kicker = document.createElement("p");
      kicker.className = "kicker";
      kicker.textContent = "MCP / STATIC SOLVE";
      const title = document.createElement("h1");
      title.textContent = "Static solve observations";
      heading.append(kicker, title);
      const readout = document.createElement("span");
      readout.className = "readout";
      readout.textContent = "COMPONENT SURFACE";
      header.append(heading, readout);

      const surfaceRoot = document.createElement("div");
      surfaceRoot.className = "surface-root";
      viewer.append(header, surfaceRoot);
      cleanup = mountSurfaceLifecycle(surfaceRoot, ctx, result);
      return viewer;
    },
    async onLeave() {
      const activeCleanup = cleanup;
      cleanup = undefined;
      await activeCleanup?.();
    },
  });
}

function mountSurfaceLifecycle(
  root: HTMLElement,
  ctx: AppContext<ViewerState>,
  result: ReturnType<typeof parseStaticSolve>,
): () => Promise<void> {
  let mounted: MountedComponentSurface | undefined;
  let disposed = false;
  let queue = Promise.resolve();

  const mount = () => {
    queue = queue.then(async () => {
      await mounted?.dispose();
      mounted = undefined;
      if (disposed) return;
      mounted = await mountComponentSurface({
        root,
        registry: CALCULIX_COMPONENT_REGISTRY,
        data: result,
        appContext: ctx,
        hostContext: ctx.hostContext,
      });
    }).catch((error) => {
      if (!disposed) renderSurfaceError(root, error);
    });
  };

  // The initial negotiated surface is available after ui/initialize. A later
  // host-context change may replace it without recreating the iframe.
  const onHostContextChanged = () => mount();
  ctx.app.addEventListener("hostcontextchanged", onHostContextChanged);
  mount();

  return async () => {
    disposed = true;
    ctx.app.removeEventListener("hostcontextchanged", onHostContextChanged);
    await queue;
    await mounted?.dispose();
    mounted = undefined;
  };
}

function renderSurfaceError(root: HTMLElement, error: unknown): void {
  const state = document.createElement("div");
  state.className = "state error";
  state.setAttribute("role", "alert");
  const title = document.createElement("h2");
  title.textContent = "Unable to mount component surface";
  const detail = document.createElement("p");
  detail.textContent = error instanceof Error
    ? error.message
    : "The requested CalculiX component surface is invalid.";
  state.append(title, detail);
  root.replaceChildren(state);
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
