import {
  type AppHandle,
  createComposeEventClient,
  createMcpApp,
  defineView,
} from "@casys/mcp-view";
import {
  installMcpViewTheme,
  mountComponentSurface,
  type MountedComponentSurface,
} from "@casys/mcp-view-components";
import {
  CALCULIX_VIEW_APP_MANIFEST,
  CALCULIX_VIEWER_SESSION_SCHEMA,
  VIEWER_SESSION_APPLY_ACTION,
} from "../../../viewer-session.ts";
import {
  CALCULIX_COMPONENT_REGISTRY,
  CALCULIX_RESULTS_SURFACE,
} from "./components.tsx";
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
    onEnter: (_context, next) => next,
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
    onEnter: (_context, data) => data,
    render(context, data) {
      const shell = document.createElement("div");
      shell.className = "calculix-component-surface";

      const generation = ++mountGeneration;
      pendingMount = mountComponentSurface({
        root: shell,
        registry: CALCULIX_COMPONENT_REGISTRY,
        data,
        appContext: context,
        hostContext: context.hostContext,
        surface: CALCULIX_RESULTS_SURFACE,
      }).then(async (next) => {
        if (generation !== mountGeneration) {
          await next.dispose();
          return;
        }
        mounted = next;
      }).catch((error) => {
        shell.replaceChildren(message(
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
        disposeSessionChannel();
        await disposeSurface();
      },
    });
  } catch (error) {
    disposeSessionChannel();
    throw error;
  }

  await sessionReceiver.activate((next) =>
    showDisplayState(handle.navigate, next)
  );
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
      return message(
        "Receiving a CalculiX result or recorded static result…",
        "neutral",
      );
    case "empty":
      return message(
        "CalculiX returned no supported result projection.",
        "neutral",
      );
    case "error":
      return message(state.message, "danger");
    case "unresolved":
      return message(
        state.reason ??
          `Recorded evidence remains ${state.status}; no result was inferred.`,
        "warning",
        "Unresolved recorded evidence",
      );
    case "unavailable":
      return message(
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

function message(
  detail: string,
  tone: "neutral" | "warning" | "danger",
  title?: string,
): HTMLElement {
  const node = document.createElement("div");
  node.className = "mcp-view-state calculix-viewer-state";
  node.dataset.tone = tone;
  node.setAttribute("role", tone === "danger" ? "alert" : "status");
  if (title) {
    const heading = document.createElement("strong");
    heading.textContent = title;
    node.append(heading);
  }
  const body = document.createElement("div");
  body.className = "mcp-view-state-detail";
  body.textContent = detail;
  node.append(body);
  return node;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
