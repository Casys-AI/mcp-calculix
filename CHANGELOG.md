# Changelog

All notable changes to `@casys/mcp-calculix` will be documented in this file.

## [Unreleased]

## [0.5.0] - 2026-08-05

### Added

- **`calculix_solve_modal`** — eigenfrequency (*FREQUENCY) analysis: STEP →
  Gmsh mesh → CalculiX free-vibration solve → natural frequencies in Hz.
  - `density_kg_m3` is required (no default); converted to t/mm³ by exact
    factor 1e-12 (1 kg/m³ = 1e-12 t/mm³ in the mm/N/MPa/t/s unit system).
  - CalculiX requires uppercase-E scientific notation for density; the deck
    builder uses `toCcxFloat()` (`Number.prototype.toExponential(6).toUpperCase()`)
    to avoid the silent rejection of lowercase-e values.
  - `n_modes` in [1, 30] (default 6). Output: `frequenciesHz[]` ascending.
  - Validated on `bracket.step` (Al 6061, 4 mm quadratic mesh, fixed base):
    f₁ = 1762.9 Hz, f₂ = 4732.5 Hz, f₃ = 9296.1 Hz.

- **`calculix_solve_buckling`** — linear buckling (*BUCKLE) analysis: STEP →
  Gmsh mesh → two-step ccx (step 1: *STATIC preload; step 2: *BUCKLE
  eigensolver) → critical load factors.
  - P_crit = load_factor × applied_load. A factor < 1 means the applied load
    already exceeds the critical buckling load.
  - The two-step deck is mandatory: the *STATIC step builds the geometric
    stiffness matrix; omitting it yields degenerate zero factors.
  - `n_modes` in [1, 30] (default 2). Loads are required.
  - Validated on `bracket.step` (Al 6061, 4 mm quadratic mesh, 500 N on wing):
    factor₁ = 61.11 (P_crit,1 ≈ 30.6 kN), factor₂ = 514.4.

### Changed

- `solveDeck()` now delegates subprocess management to the private
  `runCcxRaw()` helper, eliminating code duplication across procedures.
  External interface is unchanged.

## [0.4.0] - 2026-08-02

### Changed

- **Breaking:** the closed `static-solve` result is now schema version `2.0`.
  Its required `inputArtifact` binds every solve to the exact STEP bytes passed
  to Gmsh. The strict viewer rejects both v1 results and missing provenance.
- `0.3.1` is superseded and must not be consumed: it added the required field
  while incorrectly retaining schema version `1.0`.

## [0.3.1] - 2026-08-02

### Added

- `calculix_solve_static` now snapshots the STEP input before meshing and
  returns the computed `inputArtifact` SHA-256 and byte length. Callers may
  provide `expected_step_sha256`; a mismatch fails before Gmsh or ccx starts.

### Changed

- The result viewer requires the attested input artifact and exposes its
  source, exact byte count and SHA-256. Results without provenance are rejected.

## [0.3.0] - 2026-08-01

### Changed

- Rebuild the four composable result blocks with the shared
  `@casys/mcp-view/preact` presentation primitives. Compose-selected surfaces
  now render only their requested cards, without the old standalone masthead.

## [0.2.1] - 2026-07-31

### Fixed

- Build the standalone results viewer with callback replacements, preserving
  literal `$` sequences in its minified JavaScript bundle. The published HTML
  now contains a single document and a syntactically valid inline module.

### Changed

- Pin the shared stateless server layer to `@casys/mcp-server@0.24.1`; the
  one-day dependency quarantine exception remains scoped to that package name.

## [0.2.0] - 2026-07-31

### Changed

- Migrated the server to `@casys/mcp-server@0.24.0` and the 2026-07-28 stateless
  HTTP transport.
- `calculix_solve_static` now returns a closed, versioned `static-solve` v1
  structured result: mesh counts, explicit constraints, measured extrema and
  their physical node/element IDs.
- Removed requirement conclusions and intermediate-file data from the public
  solve result. Consumers can evaluate their own requirements from the
  observations.

### Added

- A standalone `@casys/mcp-view@0.4.0` results viewer at
  `ui://mcp-calculix/results-viewer`, built into the published package.
- Stateless wire coverage for discovery, tool metadata/call and the viewer
  resource; native Gmsh/CalculiX checks are now explicit opt-in tests.

## [0.1.0] - 2026-07-30

Initial release.

### Added

- **`calculix_solve_static`** — one deterministic pipeline: STEP file → Gmsh
  tetrahedral mesh → CalculiX linear static solve → max displacement (mm) and
  max von Mises stress (MPa). Validated end to end against the build123d spike
  bracket (500 N → 26.6 MPa observed).
- **Face designation by named bounding boxes** — every surface enclosed in a
  named box in mm becomes an Abaqus NSET. A box matching no surface is a hard
  error naming the selection.
- **Everything physical explicit** — mesh size, element order (C3D4/C3D10),
  material constants (`e_mpa`, `nu` — never looked up from a name), total nodal
  forces. A selection both fixed and loaded is rejected.
- **Subprocess bridges, plain text** — Gmsh and `ccx` over files, no Python, no
  WASM. Missing binaries raise errors carrying the install commands
  (`apt install gmsh calculix-ccx`).

### Hardened against, specifically

- Gmsh's Abaqus export includes CPS6 surface triangles that CalculiX rejects —
  stripped before the solve.
- CalculiX silently skips `*NODE PRINT` on an undefined set — the all-nodes NSET
  is generated into the deck rather than assumed.

### Scope

Linear static, fully fixed supports, nodal loads. No
pressure/thermal/modal/contact yet. Units fixed: mm, N, MPa.

## [0.1.1] - 2026-07-30

### Security

- **.geo command injection via the STEP path.** Gmsh's .geo language has a
  `System` command that executes shell commands, and the STEP path was
  interpolated into `Merge "…"` unescaped — a quote in the path was an injection
  vector. Paths containing quotes, backslashes or newlines are now rejected
  before any subprocess runs.
- **HTTP mode binds to loopback by default.** These tools execute code;
  `--hostname=0.0.0.0` is now an explicit choice, not the default.
