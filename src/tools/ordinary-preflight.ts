/**
 * Shared ordinary-solve input checks that must fail before any snapshot,
 * Gmsh, or CalculiX effect. Recorded static evidence validation stays
 * independent and is not weakened by these helpers.
 */

import type { FaceSelection } from "../api/gmsh.ts";

export type OrdinaryInputErrorCode =
  | "invalid_input"
  | "unknown_input_field"
  | "zero_reference_load";

/**
 * A pre-execution input failure. `code` and `inputPath` let an embedding
 * client distinguish a typo from an invalid physical value without parsing
 * the human-facing message.
 */
export class OrdinaryInputError extends Error {
  readonly code: OrdinaryInputErrorCode;
  readonly inputPath: string | undefined;

  constructor(
    message: string,
    options: {
      code?: OrdinaryInputErrorCode;
      inputPath?: string;
    } = {},
  ) {
    super(message);
    this.name = "OrdinaryInputError";
    this.code = options.code ?? "invalid_input";
    this.inputPath = options.inputPath;
  }
}

export const SELECTION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,60}$/;
export const SHA256_HEX_PATTERN = /^[a-fA-F0-9]{64}$/;
export const DEFAULT_ELEMENT_ORDER = 2 as const;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_MESH_PREFLIGHT_SELECTIONS = 32;
export const MAX_MESH_PREFLIGHT_TIMEOUT_MS = 120_000;

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
  /** Analysis-specific documented root fields, in addition to common fields. */
  additionalInputFields?: readonly string[];
  extraReferencedNames?: string[];
  extraReferenceRole?: string;
  /** Buckling needs a non-zero reference preload to give its factors meaning. */
  requireNonZeroReferenceLoad?: boolean;
}

/**
 * Mesh-only inputs intentionally exclude material, constraints, loads, and
 * any solver control. The resulting preflight is not an FEA result.
 */
export interface MeshPreflightArgs {
  stepPath: string;
  expectedStepSha256: string | undefined;
  meshSizeMm: number;
  elementOrder: 1 | 2;
  timeoutMs: number;
  selections: FaceSelection[];
}

/** Tighten common JSON Schema bounds shared by the ordinary solve tools. */
export function tightenCommonOrdinaryInputSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  closeObjectSchemas(schema);
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

  rejectUnknownFields(
    args,
    [
      "step_path",
      "expected_step_sha256",
      "mesh_size_mm",
      "element_order",
      "material",
      "selections",
      "fixed",
      "timeout_ms",
      ...(options.loads === "none" ? [] : ["loads"]),
      ...(options.additionalInputFields ?? []),
    ],
    toolName,
  );
  rejectCommonNestedUnknownFields(args, toolName, options.loads);

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

  const selections = parseSelections(args.selections, toolName);
  const known = new Set(selections.map((selection) => selection.name));

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
  if (
    options.requireNonZeroReferenceLoad &&
    !loads.some((load) => load.force_n.some((component) => component !== 0))
  ) {
    throw fail(
      toolName,
      "reference loads must include at least one non-zero force_n component.",
      "zero_reference_load",
      "loads",
    );
  }

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

/** Close every object schema, including nested selection and boundary objects. */
export function closeObjectSchemas(
  value: Record<string, unknown>,
): Record<string, unknown> {
  for (const [key, child] of Object.entries(value)) {
    if (Array.isArray(child)) {
      value[key] = child.map((item) =>
        isRecord(item) ? closeObjectSchemas(item) : item
      );
    } else if (isRecord(child)) {
      value[key] = closeObjectSchemas(child);
    }
  }
  if (value.type === "object" && value.additionalProperties === undefined) {
    value.additionalProperties = false;
  }
  return value;
}

/**
 * Reject a misspelled or unsupported field before snapshotting or spawning a
 * native process. This mirrors `additionalProperties: false` for direct
 * handler callers, which do not pass through MCP schema validation.
 */
export function rejectUnknownFields(
  value: unknown,
  allowed: readonly string[],
  toolName: string,
  path = "",
): void {
  if (!isRecord(value)) return;
  const allowedFields = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedFields.has(key));
  if (unknown === undefined) return;
  const inputPath = path === "" ? unknown : `${path}.${unknown}`;
  throw fail(
    toolName,
    `unknown input field '${inputPath}'.`,
    "unknown_input_field",
    inputPath,
  );
}

function rejectCommonNestedUnknownFields(
  args: Record<string, unknown>,
  toolName: string,
  loads: OrdinaryLoadsMode,
): void {
  rejectUnknownFields(args.material, ["e_mpa", "nu"], toolName, "material");

  if (Array.isArray(args.selections)) {
    for (const [index, selection] of args.selections.entries()) {
      const selectionPath = `selections[${index}]`;
      rejectUnknownFields(selection, ["name", "box"], toolName, selectionPath);
      if (isRecord(selection)) {
        rejectUnknownFields(
          selection.box,
          ["min", "max"],
          toolName,
          `${selectionPath}.box`,
        );
      }
    }
  }

  if (loads !== "none" && Array.isArray(args.loads)) {
    for (const [index, load] of args.loads.entries()) {
      rejectUnknownFields(
        load,
        ["selection", "force_n"],
        toolName,
        `loads[${index}]`,
      );
    }
  }
}

/**
 * Parse a bounded mesh/selection inspection request before snapshotting or
 * starting Gmsh. This deliberately rejects solver-only fields rather than
 * accepting a static-solve payload and silently ignoring its physics.
 */
export function parseMeshPreflightArgs(
  args: Record<string, unknown>,
  toolName = "calculix_mesh_preflight",
): MeshPreflightArgs {
  const allowed = new Set([
    "step_path",
    "expected_step_sha256",
    "mesh_size_mm",
    "element_order",
    "timeout_ms",
    "selections",
  ]);
  const unknown = Object.keys(args).find((key) => !allowed.has(key));
  if (unknown) {
    throw fail(toolName, `unknown input field '${unknown}'.`);
  }

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
    throw fail(toolName, `element_order must be 1 or 2, got ${elementOrder}.`);
  }

  const timeoutMs = args.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1 ||
    (timeoutMs as number) > MAX_MESH_PREFLIGHT_TIMEOUT_MS
  ) {
    throw fail(
      toolName,
      `timeout_ms must be a positive integer no greater than ${MAX_MESH_PREFLIGHT_TIMEOUT_MS}, got ${timeoutMs}.`,
    );
  }

  const selections = parseSelections(
    args.selections,
    toolName,
    MAX_MESH_PREFLIGHT_SELECTIONS,
  );
  return {
    stepPath: args.step_path,
    expectedStepSha256,
    meshSizeMm: args.mesh_size_mm,
    elementOrder,
    timeoutMs: timeoutMs as number,
    selections,
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

function parseSelections(
  value: unknown,
  toolName: string,
  maximum?: number,
): FaceSelection[] {
  if (!Array.isArray(value) || value.length < 1) {
    throw fail(toolName, "selections must be a non-empty array.");
  }
  if (maximum !== undefined && value.length > maximum) {
    throw fail(
      toolName,
      `selections must contain no more than ${maximum} items.`,
    );
  }

  const known = new Set<string>();
  const selections: FaceSelection[] = [];
  const selectionNames = new Set<string>();
  for (const [index, selection] of value.entries()) {
    if (!isRecord(selection)) {
      throw fail(toolName, `selection ${index} is invalid.`);
    }
    if (
      typeof selection.name !== "string" ||
      !SELECTION_NAME_PATTERN.test(selection.name) ||
      known.has(selection.name)
    ) {
      throw fail(
        toolName,
        `selection ${index} has an invalid or duplicate name.`,
      );
    }
    known.add(selection.name);
    if (!isRecord(selection.box)) {
      throw fail(
        toolName,
        `selection '${selection.name}' box must have finite min and max.`,
      );
    }
    const min = finiteVector3(selection.box.min);
    const max = finiteVector3(selection.box.max);
    if (
      min === undefined || max === undefined ||
      min.some((lo, axis) => lo >= max[axis])
    ) {
      throw fail(
        toolName,
        `selection '${selection.name}': box min must be strictly below max ` +
          `on every axis (got min=${JSON.stringify(selection.box.min)}, max=${
            JSON.stringify(selection.box.max)
          }).`,
      );
    }
    const canonicalName = selection.name.toUpperCase();
    if (selectionNames.has(canonicalName)) {
      throw fail(
        toolName,
        "selection names must be unique case-insensitively.",
      );
    }
    selectionNames.add(canonicalName);
    selections.push({ name: selection.name, box: { min, max } });
  }
  return selections;
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

function fail(
  toolName: string,
  message: string,
  code: OrdinaryInputErrorCode = "invalid_input",
  inputPath?: string,
): OrdinaryInputError {
  return new OrdinaryInputError(`[${toolName}] ${message}`, {
    code,
    inputPath,
  });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
