import { createTranslator } from "@casys/mcp-view-components";

const CALCULIX_MESSAGES_EN = {
  loading: "Receiving a CalculiX result or recorded static result…",
  empty: "CalculiX returned no supported result projection.",
  recordedStaticResponse: "Recorded static response",
  staticResponse: "Static response",
  maxDisplacement: "Maximum displacement",
  maxVonMises: "Maximum von Mises",
  node: "Node {id}",
  element: "Element {id}",
  nodes: "Nodes",
  elements: "Elements",
  selection: "Selection",
  selectionNodes: "{count} nodes",
  fixed: "Fixed",
  load: "Load",
  model: "Model",
  boundaryConditions: "Boundary conditions",
  technicalDetails: "Technical details",
  resultArtifact: "Result artifact",
  inputBasis: "Input basis",
  unresolvedEvidence: "Unresolved recorded evidence",
  unavailableEvidence: "Recorded evidence unavailable",
  unresolvedFallback:
    "Recorded evidence remains {status}; no result was inferred.",
  unavailableFallback:
    "Recorded evidence is {status}; no result was substituted.",
  sessionRejectedMessage: "Rejected {schema} session: {error}",
  viewerUnavailable: "CalculiX viewer unavailable",
  viewerCouldNotStart: "The viewer could not start.",
} as const;

export type CalculixMessageKey = keyof typeof CALCULIX_MESSAGES_EN;

const CALCULIX_MESSAGES_FR: {
  readonly [Key in CalculixMessageKey]: string;
} = {
  loading:
    "Réception d'un résultat CalculiX ou d'un résultat statique enregistré…",
  empty: "CalculiX n'a renvoyé aucune projection de résultat prise en charge.",
  recordedStaticResponse: "Réponse statique enregistrée",
  staticResponse: "Réponse statique",
  maxDisplacement: "Déplacement maximal",
  maxVonMises: "von Mises maximal",
  node: "Nœud {id}",
  element: "Élément {id}",
  nodes: "Nœuds",
  elements: "Éléments",
  selection: "Sélection",
  selectionNodes: "{count} nœuds",
  fixed: "Fixe",
  load: "Charge",
  model: "Modèle",
  boundaryConditions: "Conditions aux limites",
  technicalDetails: "Détails techniques",
  resultArtifact: "Artefact de résultat",
  inputBasis: "Base d'entrée",
  unresolvedEvidence: "Preuve enregistrée non résolue",
  unavailableEvidence: "Preuve enregistrée indisponible",
  unresolvedFallback:
    "La preuve enregistrée reste {status} ; aucun résultat n'a été inféré.",
  unavailableFallback:
    "La preuve enregistrée est {status} ; aucun résultat n'a été substitué.",
  sessionRejectedMessage: "Session {schema} rejetée : {error}",
  viewerUnavailable: "Visualiseur CalculiX indisponible",
  viewerCouldNotStart: "Le visualiseur n'a pas pu démarrer.",
};

/** Interface wording only. Domain statuses, identifiers and diagnostics stay exact. */
export const calculixMessages = createTranslator({
  defaultLocale: "en",
  messages: CALCULIX_MESSAGES_EN,
  translations: { fr: CALCULIX_MESSAGES_FR },
});

/** Host locale for presentation; invalid or absent locales use English. */
export function formatNumber(value: number, locale?: string): string {
  return numberFormat(locale, { maximumFractionDigits: 5 }).format(value);
}

export function formatCount(value: number, locale?: string): string {
  return numberFormat(locale).format(value);
}

function numberFormat(
  locale: string | undefined,
  options?: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  try {
    return new Intl.NumberFormat(
      locale && locale.trim() ? locale : "en",
      options,
    );
  } catch {
    return new Intl.NumberFormat("en", options);
  }
}
