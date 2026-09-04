import {
  type PreactSurfaceAppOptions,
  renderStatusMessage,
  startPreactSurfaceApp,
  type SurfaceAppHandle,
  type SurfaceDisplayState,
} from "@casys/mcp-view-components/preact";
import { installMcpViewFonts } from "@casys/mcp-view-components/fonts";
import {
  CALCULIX_VIEW_APP_MANIFEST,
  CALCULIX_VIEWER_SESSION_SCHEMA,
} from "../../../viewer-session.ts";
import { CALCULIX_COMPONENT_REGISTRY } from "./components.tsx";
import {
  type DisplayState,
  displayStateFromToolResult,
  displayStateFromViewerSession,
  type StaticResultsViewData,
} from "./model.ts";

export const CALCULIX_APP_INFO = {
  name: CALCULIX_VIEW_APP_MANIFEST.app.id,
  version: CALCULIX_VIEW_APP_MANIFEST.app.version,
} as const;

/** The status class every CalculiX message carries, in and out of the App. */
export const CALCULIX_STATUS_CLASS = "calculix-viewer-state";
/** `code` of the danger state shown when a recorded session fails the strict parser. */
export const SESSION_REJECTED_CODE = "session-rejected";

export type CalculixSurfaceState = SurfaceDisplayState<StaticResultsViewData>;

export type CalculixSurfaceAppOptions = PreactSurfaceAppOptions<
  StaticResultsViewData,
  unknown
>;

/**
 * Start the MCP-owned CalculiX projection.
 *
 * The App lifecycle — loading until the first result, one projection per tool
 * result, the host-selected surface remounted when the host context moves,
 * recorded sessions buffered before the transport connects — belongs to
 * `startPreactSurfaceApp`. This module only says what CalculiX projects and
 * how its statuses read.
 */
export function startCalculixResultsApp(
  root: HTMLElement,
): Promise<SurfaceAppHandle<StaticResultsViewData>> {
  // Hosts sandbox the App without web fonts; the kit embeds its three faces.
  installMcpViewFonts(root.ownerDocument);
  return startPreactSurfaceApp(calculixSurfaceAppOptions(root));
}

/** The App configuration, exposed so its projections are testable without a host. */
export function calculixSurfaceAppOptions(
  root: HTMLElement,
): CalculixSurfaceAppOptions {
  return {
    root,
    info: CALCULIX_APP_INFO,
    registry: CALCULIX_COMPONENT_REGISTRY,
    strict: true,
    surfaceClassName: "calculix-component-surface",
    statusClassName: CALCULIX_STATUS_CLASS,
    loadingLabel: "Receiving a CalculiX result or recorded static result…",
    emptyLabel: "CalculiX returned no supported result projection.",
    fromToolResult: async (result, host) =>
      toSurfaceState(
        await displayStateFromToolResult(result, host.readServerResource),
      ),
    viewerSession: {
      // Every `viewer.session.apply` payload addresses this whole-view App;
      // the strict parser decides, and a rejection is shown, never dropped.
      validate: (_value: unknown): _value is unknown => true,
      toState: async (value) => {
        try {
          return toSurfaceState(await displayStateFromViewerSession(value));
        } catch (error) {
          return {
            kind: "error",
            title: "Session rejected",
            code: SESSION_REJECTED_CODE,
            message: `Rejected ${CALCULIX_VIEWER_SESSION_SCHEMA} session: ${
              errorMessage(error)
            }`,
          };
        }
      },
    },
    onError: (error) => {
      console.error("[mcp-calculix] Results projection failed", error);
    },
  };
}

/**
 * Map a CalculiX display state onto the shared surface states. Unresolved and
 * unavailable recorded evidence are notices, not errors: nothing failed, the
 * ledger simply holds no result to show. `code` carries the ledger status.
 */
export function toSurfaceState(state: DisplayState): CalculixSurfaceState {
  switch (state.kind) {
    case "loading":
    case "empty":
    case "error":
    case "result":
      return state;
    case "unresolved":
      return {
        kind: "notice",
        tone: "warning",
        title: "Unresolved recorded evidence",
        message: state.reason ??
          `Recorded evidence remains ${state.status}; no result was inferred.`,
        code: state.status,
      };
    case "unavailable":
      return {
        kind: "notice",
        tone: "warning",
        title: "Recorded evidence unavailable",
        message: state.reason ??
          `Recorded evidence is ${state.status}; no result was substituted.`,
        code: state.status,
      };
  }
}

/** The one status the App cannot render itself: its own failure to start. */
export function renderStartupFailure(error: unknown): HTMLElement {
  return renderStatusMessage(
    error instanceof Error ? error.message : "The viewer could not start.",
    {
      className: CALCULIX_STATUS_CLASS,
      title: "CalculiX viewer unavailable",
      tone: "danger",
    },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
