import { mcpViewMessages } from "@casys/mcp-view-components";
import {
  type PreactSurfaceAppOptions,
  renderStatusMessage,
  startPreactSurfaceApp,
  type SurfaceAppHandle,
  type SurfaceDisplayState,
  type SurfaceLabel,
} from "@casys/mcp-view-components/preact";
import { installMcpViewFonts } from "@casys/mcp-view-components/fonts";
import {
  CALCULIX_VIEW_APP_MANIFEST,
  CALCULIX_VIEWER_SESSION_SCHEMA,
} from "../../../viewer-session.ts";
import { CALCULIX_COMPONENT_REGISTRY } from "./components.tsx";
import { calculixMessages } from "./i18n.ts";
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
    themeUpdates: "in-place",
    documentLanguage: calculixMessages.locale,
    loadingLabel: (locale) => calculixMessages(locale)("loading"),
    emptyLabel: (locale) => calculixMessages(locale)("empty"),
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
          const diagnostic = errorMessage(error);
          return {
            kind: "error",
            title: sessionRejectedTitle,
            code: SESSION_REJECTED_CODE,
            message: (locale) =>
              calculixMessages(locale)("sessionRejectedMessage", {
                schema: CALCULIX_VIEWER_SESSION_SCHEMA,
                error: diagnostic,
              }),
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
 * Interface titles and fallbacks are SurfaceLabel callbacks, resolved when the
 * status renders; raw `reason` stays literal.
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
        title: unresolvedTitle,
        message: state.reason ?? unresolvedFallback(state.status),
        code: state.status,
      };
    case "unavailable":
      return {
        kind: "notice",
        tone: "warning",
        title: unavailableTitle,
        message: state.reason ?? unavailableFallback(state.status),
        code: state.status,
      };
  }
}

const unresolvedTitle: SurfaceLabel = (locale) =>
  calculixMessages(locale)("unresolvedEvidence");
const unavailableTitle: SurfaceLabel = (locale) =>
  calculixMessages(locale)("unavailableEvidence");
const sessionRejectedTitle: SurfaceLabel = (locale) =>
  mcpViewMessages(locale)("sessionRejectedTitle");

function unresolvedFallback(status: string): SurfaceLabel {
  return (locale) => calculixMessages(locale)("unresolvedFallback", { status });
}

function unavailableFallback(status: string): SurfaceLabel {
  return (locale) =>
    calculixMessages(locale)("unavailableFallback", { status });
}

/** The one status the App cannot render itself: its own failure to start. */
export function renderStartupFailure(
  error: unknown,
  locale?: string,
): HTMLElement {
  const t = calculixMessages(locale);
  return renderStatusMessage(
    error instanceof Error ? error.message : t("viewerCouldNotStart"),
    {
      className: CALCULIX_STATUS_CLASS,
      title: t("viewerUnavailable"),
      tone: "danger",
    },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
