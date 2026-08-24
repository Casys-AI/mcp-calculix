/**
 * Shared ordinary-solve input checks that must fail before any snapshot,
 * Gmsh, or CalculiX effect. Recorded static evidence validation stays
 * independent and is not weakened by these helpers.
 */

import type { FaceSelection } from "../api/gmsh.ts";

export class OrdinaryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrdinaryInputError";
  }
}

export const SELECTION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,60}$/;
export const SHA256_HEX_PATTERN = /^[a-fA-F0-9]{64}$/;
export const DEFAULT_ELEMENT_ORDER = 2 as const;
export const DEFAULT_TIMEOUT_MS = 120_000;

export type OrdinaryLoadsMode = "required" | "optional" | "none";

export interface OrdinaryPreflight {
  stepPath: string;
  expectedStepSha256: string | undefined;
  meshSizeMm: number;
  elementOrder: 1 | 2;
  timeoutMs: number;
  material: { e_mpa: number; nu: number };
  selections: FaceSelection[];
  fixed: string[];
  loads: Array<{ selection: string; force_n: [number, number, number] }>;
}

export interface OrdinaryPreflightOptions {
  toolName: string;
  loads: OrdinaryLoadsMode;
  extraReferencedNames?: string[];
  extraReferenceRole?: string;
}

/** Tighten common JSON Schema bounds shared by the ordinary solve tools. */
export function tightenCommonOrdinaryInputSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const properties = schema.properties;
  if (!isRecord(properties)) return schema;

  if (isRecord(properties.step_path)) {
    properties.step_path = { ...properties.step_path, minLength: 1 };
  }
  if (isRecord(properties.mesh_size_mm)) {
    properties.mesh_size_mm = {
      ...properties.mesh_size_mm,
      exclusiveMinimum: 0,
    };
  }
  if (isRecord(properties.element_order)) {
    properties.element_order = {
      ...properties.element_order,
      type: "integer",
    };
  }
  if (isRecord(properties.timeout_ms)) {
    properties.timeout_ms = {
      ...properties.timeout_ms,
      type: "integer",
      minimum: 1,
    };
  }

  if (isRecord(properties.material)) {
    const materialProperties = properties.material.properties;
    if (isRecord(materialProperties)) {
      if (isRecord(materialProperties.e_mpa)) {
        materialProperties.e_mpa = {
          ...materialProperties.e_mpa,
          exclusiveMinimum: 0,
        };
      }
      if (isRecord(materialProperties.nu)) {
        materialProperties.nu = {
          ...materialProperties.nu,
          exclusiveMinimum: 0,
          exclusiveMaximum: 0.5,
        };
      }
    }
  }

  if (isRecord(properties.selections)) {
    const item = properties.selections.items;
    if (isRecord(item) && isRecord(item.properties)) {
      if (isRecord(item.properties.name)) {
        item.properties.name = tightenNameSchema(item.properties.name);
      }
    }
  }

  if (isRecord(properties.fixed)) {
    properties.fixed = {
      ...properties.fixed,
      uniqueItems: true,
      items: tightenNameSchema(
        isRecord(properties.fixed.items) ? properties.fixed.items : {},
      ),
    };
  }

  tightenSelectionField(properties.loads);
  tightenSelectionField(properties.thermal_bcs);
  return schema;
}

/**
 * Parse and reject common physical inputs before snapshotStepArtifact or any
 * native subprocess. Analysis-specific guards stay in each handler.
 */
export function parseOrdinarySolveArgs(
  args: Record<string, unknown>,
  options: OrdinaryPreflightOptions,
): OrdinaryPreflight {
  const { toolName } = options;

  if (
    typeof args.step_path !== "string" || args.step_path.length < 1 ||
    args.step_path.includes("\0")
  ) {
    throw fail(toolName, "step_path must be a non-empty string.");
  }

  let expectedStepSha256: string | undefined;
  if (args.expected_step_sha256 !== undefined) {
    if (
      typeof args.expected_step_sha256 !== "string" ||
      !SHA256_HEX_PATTERN.test(args.expected_step_sha256)
    ) {
      throw fail(
        toolName,
        "expected_step_sha256 must be a 64-character hexadecimal SHA-256 digest.",
      );
    }
    expectedStepSha256 = args.expected_step_sha256;
  }

  if (!isFiniteNumber(args.mesh_size_mm) || args.mesh_size_mm <= 0) {
    throw fail(
      toolName,
      `mesh_size_mm must be a positive finite number, got ${args.mesh_size_mm}.`,
    );
  }

  const elementOrder = args.element_order ?? DEFAULT_ELEMENT_ORDER;
  if (elementOrder !== 1 && elementOrder !== 2) {
    throw fail(
      toolName,
      `element_order must be 1 or 2, got ${elementOrder}.`,
    );
  }

  const timeoutMs = args.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1) {
    throw fail(
      toolName,
      `timeout_ms must be a positive integer, got ${timeoutMs}.`,
    );
  }

  if (!isRecord(args.material)) {
    throw fail(toolName, "material must be an object with e_mpa and nu.");
  }
  const eMpa = args.material.e_mpa;
  const nu = args.material.nu;
  if (
    !isFiniteNumber(eMpa) || eMpa <= 0 ||
    !isFiniteNumber(nu) || !(nu > 0 && nu < 0.5)
  ) {
    throw fail(
      toolName,
      `material out of range: e_mpa must be > 0 and nu in (0, 0.5), got ` +
        `e_mpa=${eMpa}, nu=${nu}.`,
    );
  }

  if (!Array.isArray(args.selections) || args.selections.length < 1) {
    throw fail(toolName, "selections must be a non-empty array.");
  }
  const known = new Set<string>();
  const selections: FaceSelection[] = [];
  for (const [index, value] of args.selections.entries()) {
    if (!isRecord(value)) {
      throw fail(toolName, `selection ${index} is invalid.`);
    }
    if (
      typeof value.name !== "string" ||
      !SELECTION_NAME_PATTERN.test(value.name) ||
      known.has(value.name)
    ) {
      throw fail(
        toolName,
        `selection ${index} has an invalid or duplicate name.`,
      );
    }
    known.add(value.name);
    if (!isRecord(value.box)) {
      throw fail(
        toolName,
        `selection '${value.name}' box must have finite min and max.`,
      );
    }
    const min = finiteVector3(value.box.min);
    const max = finiteVector3(value.box.max);
    if (
      min === undefined || max === undefined ||
      min.some((lo, axis) => lo >= max[axis])
    ) {
      throw fail(
        toolName,
        `selection '${value.name}': box min must be strictly below max ` +
          `on every axis (got min=${JSON.stringify(value.box.min)}, max=${
            JSON.stringify(value.box.max)
          }).`,
      );
    }
    selections.push({ name: value.name, box: { min, max } });
  }

  if (!Array.isArray(args.fixed) || args.fixed.length < 1) {
    throw fail(toolName, "fixed must be a non-empty array.");
  }
  const fixed: string[] = [];
  for (const name of args.fixed) {
    if (typeof name !== "string" || !SELECTION_NAME_PATTERN.test(name)) {
      throw fail(toolName, `fixed contains an invalid name '${name}'.`);
    }
    if (fixed.includes(name)) {
      throw fail(toolName, "fixed selections contain duplicates.");
    }
    fixed.push(name);
  }

  const loads = parseLoads(toolName, args.loads, options.loads);

  const extraReferencedNames = options.extraReferencedNames ?? [];
  for (const name of extraReferencedNames) {
    if (typeof name !== "string" || !SELECTION_NAME_PATTERN.test(name)) {
      throw fail(
        toolName,
        `'${name}' is referenced in ` +
          `${options.extraReferenceRole ?? "boundary conditions"} ` +
          `but is not a valid selection name.`,
      );
    }
  }

  const role = options.extraReferenceRole ??
    (options.loads === "none" ? "fixed" : "fixed/loads");
  for (
    const name of [
      ...fixed,
      ...loads.map((load) => load.selection),
      ...extraReferencedNames,
    ]
  ) {
    if (!known.has(name)) {
      throw fail(
        toolName,
        `'${name}' is referenced in ${role} but not declared in selections ` +
          `(${[...known].join(", ")}).`,
      );
    }
  }

  const overlap = fixed.filter((name) =>
    loads.some((load) => load.selection === name)
  );
  if (overlap.length > 0) {
    throw fail(
      toolName,
      `${overlap.join(", ")} is both fixed and loaded — a fully fixed node ` +
        `ignores its load, which is almost certainly not what you meant.`,
    );
  }

  return {
    stepPath: args.step_path,
    expectedStepSha256,
    meshSizeMm: args.mesh_size_mm,
    elementOrder,
    timeoutMs: timeoutMs as number,
    material: { e_mpa: eMpa, nu },
    selections,
    fixed,
    loads,
  };
}

function parseLoads(
  toolName: string,
  raw: unknown,
  mode: OrdinaryLoadsMode,
): Array<{ selection: string; force_n: [number, number, number] }> {
  if (mode === "none") return [];
  if (mode === "required") {
    if (!Array.isArray(raw) || raw.length < 1) {
      throw fail(toolName, "loads must be a non-empty array.");
    }
  } else if (raw !== undefined && !Array.isArray(raw)) {
    throw fail(toolName, "loads must be an array when provided.");
  }
  const list = Array.isArray(raw) ? raw : [];
  const loads: Array<{ selection: string; force_n: [number, number, number] }> =
    [];
  for (const [index, value] of list.entries()) {
    if (!isRecord(value)) {
      throw fail(toolName, `load ${index} is invalid.`);
    }
    if (
      typeof value.selection !== "string" ||
      !SELECTION_NAME_PATTERN.test(value.selection)
    ) {
      throw fail(toolName, `load ${index} has an invalid selection.`);
    }
    const force = finiteVector3(value.force_n);
    if (force === undefined) {
      throw fail(
        toolName,
        `load ${index} force_n must be three finite numbers.`,
      );
    }
    loads.push({ selection: value.selection, force_n: force });
  }
  return loads;
}

function tightenSelectionField(value: unknown): void {
  if (!isRecord(value) || !isRecord(value.items)) return;
  const properties = value.items.properties;
  if (!isRecord(properties) || !isRecord(properties.selection)) return;
  properties.selection = tightenNameSchema(properties.selection);
}

function tightenNameSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...schema,
    type: "string",
    pattern: SELECTION_NAME_PATTERN.source,
  };
}

function finiteVector3(
  value: unknown,
): [number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 3) return undefined;
  if (!value.every((item) => isFiniteNumber(item))) return undefined;
  return [value[0], value[1], value[2]];
}

function fail(toolName: string, message: string): OrdinaryInputError {
  return new OrdinaryInputError(`[${toolName}] ${message}`);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
