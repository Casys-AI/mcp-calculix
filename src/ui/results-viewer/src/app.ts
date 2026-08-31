import {
  type AppHandle,
  createComposeEventClient,
  createMcpApp,
  defineView,
} from "@casys/mcp-view";
import {
  activeComponentSurface,
  applySurfaceContext,
  componentCatalogCapabilities,
  type ComponentSurface,
  installMcpViewTheme,
  type McpViewHostContext,
  mountComponentSurface,
  type MountedComponentSurface,
} from "@casys/mcp-view-components";
import {
  type PresentationTone,
  StateMessage,
} from "@casys/mcp-view-components/preact/components";
import { createElement, render } from "preact";
import {
  CALCULIX_VIEW_APP_MANIFEST,
  CALCULIX_VIEWER_SESSION_SCHEMA,
  VIEWER_SESSION_APPLY_ACTION,
} from "../../../viewer-session.ts";
import { CALCULIX_COMPONENT_REGISTRY } from "./components.tsx";
import {
  type DisplayState,
  displayStateFromToolResult,
  displayStateFromViewerSession,
  type StaticResultsViewData,
} from "./model.ts";
import { createBufferedSessionReceiver } from "./session-receiver.ts";

type ResultsViewerState = Record<string, never>;

export const CALCULIX_APP_INFO = {
  name: CALCULIX_VIEW_APP_MANIFEST.app.id,
  version: CALCULIX_VIEW_APP_MANIFEST.app.version,
} as const;

/** Start the MCP-owned CalculiX projection and its read-only session receiver. */
export async function startCalculixResultsApp(
  root: HTMLElement,
): Promise<void> {
  installMcpViewTheme();
  const state: ResultsViewerState = {};
  let mounted: MountedComponentSurface | undefined;
  let pendingMount: Promise<void> | undefined;
  let mountGeneration = 0;
  let currentResult: StaticResultsViewData | undefined;
  let removeHostContextListener: (() => void) | undefined;

  const reportError = (error: unknown): void => {
    console.error("[mcp-calculix] Results projection failed", error);
  };

  // The published mcp-view version does not yet expose its pre-connect
  // viewerSession option. Keep the same App-level FIFO lifecycle locally so
  // a one-shot host action cannot be lost while ext-apps connects or a
  // component surface remounts.
  const sessionEvents = createComposeEventClient();
  const sessionReceiver = createBufferedSessionReceiver<DisplayState>({
    events: sessionEvents,
    action: VIEWER_SESSION_APPLY_ACTION,
    async map(value) {
      try {
        return await displayStateFromViewerSession(value);
      } catch (error) {
        return {
          kind: "error",
          message: `Rejected ${CALCULIX_VIEWER_SESSION_SCHEMA} session: ${
            errorMessage(error)
          }`,
        };
      }
    },
    onError: reportError,
  });

  const disposeSessionChannel = (): void => {
    sessionReceiver.dispose();
    sessionEvents.destroy();
  };

  const disposeSurface = async (): Promise<void> => {
    mountGeneration += 1;
    await pendingMount;
    pendingMount = undefined;
    const active = mounted;
    mounted = undefined;
    await active?.dispose();
  };

  const status = defineView<ResultsViewerState, DisplayState, DisplayState>({
    onEnter: (_context, next) => {
      currentResult = undefined;
      return next;
    },
    render(_context, next) {
      return renderDisplayState(next);
    },
    onLeave: disposeSurface,
  });

  const surface = defineView<
    ResultsViewerState,
    StaticResultsViewData,
    StaticResultsViewData
  >({
    onEnter: (_context, data) => {
      currentResult = data;
      return data;
    },
    render(context, data) {
      const shell = document.createElement("div");
      shell.className = "calculix-component-surface";
      const resolution = resolveCalculixSurface(context.hostContext);
      if (!resolution.ok) {
        shell.replaceChildren(renderStateMessage(
          resolution.message,
          "danger",
        ));
        return shell;
      }
      const selected = resolution.surface;

      const generation = ++mountGeneration;
      pendingMount = mountComponentSurface({
        root: shell,
        registry: CALCULIX_COMPONENT_REGISTRY,
        data,
        appContext: context,
        hostContext: context.hostContext,
        surface: selected,
      }).then(async (next) => {
        if (generation !== mountGeneration) {
          await next.dispose();
          return;
        }
        mounted = next;
      }).catch((error) => {
        shell.replaceChildren(renderStateMessage(
          `The CalculiX component surface failed: ${errorMessage(error)}`,
          "danger",
        ));
        reportError(error);
      });
      return shell;
    },
    onLeave: disposeSurface,
  });

  let handle: AppHandle<ResultsViewerState>;
  try {
    handle = await createMcpApp<ResultsViewerState>({
      info: CALCULIX_APP_INFO,
      root,
      strict: true,
      views: { status, surface },
      initialView: "status",
      initialArgs: { kind: "loading" } satisfies DisplayState,
      initialState: state,
      capabilities: {
        experimental: componentCatalogCapabilities(
          CALCULIX_COMPONENT_REGISTRY,
        ),
      },
      onToolInputPartial: async (_params, app) => {
        await app.navigate(
          "status",
          { kind: "loading" } satisfies DisplayState,
        );
      },
      onToolResult: async (result, app) => {
        try {
          const next = await displayStateFromToolResult(
            result,
            (uri) => app.ctx.app.readServerResource({ uri }),
          );
          await showDisplayState(app.navigate, next);
        } catch (error) {
          await app.navigate(
            "status",
            {
              kind: "error",
              message: errorMessage(error),
            } satisfies DisplayState,
          );
        }
      },
      onTeardown: async () => {
        removeHostContextListener?.();
        removeHostContextListener = undefined;
        currentResult = undefined;
        disposeSessionChannel();
        await disposeSurface();
      },
    });
  } catch (error) {
    disposeSessionChannel();
    throw error;
  }

  const onHostContextChanged = (): void => {
    applySurfaceContext(handle.ctx.hostContext, document.documentElement);
    if (!currentResult || handle.currentView !== "surface") return;
    void handle.navigate("surface", currentResult).catch(reportError);
  };
  handle.ctx.app.addEventListener("hostcontextchanged", onHostContextChanged);
  applySurfaceContext(handle.ctx.hostContext, document.documentElement);
  removeHostContextListener = () => {
    handle.ctx.app.removeEventListener(
      "hostcontextchanged",
      onHostContextChanged,
    );
  };

  await sessionReceiver.activate((next) =>
    showDisplayState(handle.navigate, next)
  );
}

export type CalculixSurfaceResolution =
  | { readonly ok: true; readonly surface: ComponentSurface }
  | { readonly ok: false; readonly message: string };

/** Keep the active route mounted when a host sends a malformed surface. */
export function resolveCalculixSurface(
  hostContext: McpViewHostContext,
): CalculixSurfaceResolution {
  try {
    const surface = activeComponentSurface(
      CALCULIX_COMPONENT_REGISTRY,
      hostContext,
    );
    return surface ? { ok: true, surface } : {
      ok: false,
      message:
        "This App exposes components and requires a host-selected surface.",
    };
  } catch (error) {
    return {
      ok: false,
      message: `The host-selected component surface is invalid: ${
        errorMessage(error)
      }`,
    };
  }
}

async function showDisplayState(
  navigate: (name: string, args?: unknown) => Promise<void>,
  state: DisplayState,
): Promise<void> {
  if (state.kind === "result") {
    await navigate("surface", state.result);
    return;
  }
  await navigate("status", state);
}

export function renderDisplayState(state: DisplayState): HTMLElement {
  switch (state.kind) {
    case "loading":
      return renderStateMessage(
        "Receiving a CalculiX result or recorded static result…",
        "neutral",
        undefined,
        true,
      );
    case "empty":
      return renderStateMessage(
        "CalculiX returned no supported result projection.",
        "neutral",
      );
    case "error":
      return renderStateMessage(state.message, "danger");
    case "unresolved":
      return renderStateMessage(
        state.reason ??
          `Recorded evidence remains ${state.status}; no result was inferred.`,
        "warning",
        "Unresolved recorded evidence",
      );
    case "unavailable":
      return renderStateMessage(
        state.reason ??
          `Recorded evidence is ${state.status}; no result was substituted.`,
        "warning",
        "Recorded evidence unavailable",
      );
    case "result":
      throw new TypeError(
        "Result data must render through the component surface.",
      );
  }
}

/** Render the shared state primitive where the view lifecycle expects an element. */
export function renderStateMessage(
  detail: string,
  tone: PresentationTone,
  title?: string,
  busy = false,
): HTMLElement {
  const host = document.createElement("div");
  render(
    createElement(
      StateMessage,
      { busy, className: "calculix-viewer-state", title, tone },
      detail,
    ),
    host,
  );
  const node = host.firstElementChild;
  if (!node) {
    throw new Error("The shared CalculiX state message did not render.");
  }
  return node as HTMLElement;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
