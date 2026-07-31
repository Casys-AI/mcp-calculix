# Changelog

All notable changes to `@casys/mcp-calculix` will be documented in this file.

## [0.2.1] - 2026-07-31

### Fixed

- Build the standalone results viewer with callback replacements, preserving
  literal `$` sequences in its minified JavaScript bundle. The published HTML
  now contains a single document and a syntactically valid inline module.

## [0.2.0] - 2026-07-31

### Changed

- Migrated the server to `@casys/mcp-server@0.24.0` and the 2026-07-28
  stateless HTTP transport.
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

- **`calculix_solve_static`** — one deterministic pipeline: STEP file → Gmsh tetrahedral mesh → CalculiX linear static solve → max displacement (mm) and max von Mises stress (MPa). Validated end to end against the build123d spike bracket (500 N → 26.6 MPa observed).
- **Face designation by named bounding boxes** — every surface enclosed in a named box in mm becomes an Abaqus NSET. A box matching no surface is a hard error naming the selection.
- **Everything physical explicit** — mesh size, element order (C3D4/C3D10), material constants (`e_mpa`, `nu` — never looked up from a name), total nodal forces. A selection both fixed and loaded is rejected.
- **Subprocess bridges, plain text** — Gmsh and `ccx` over files, no Python, no WASM. Missing binaries raise errors carrying the install commands (`apt install gmsh calculix-ccx`).

### Hardened against, specifically

- Gmsh's Abaqus export includes CPS6 surface triangles that CalculiX rejects — stripped before the solve.
- CalculiX silently skips `*NODE PRINT` on an undefined set — the all-nodes NSET is generated into the deck rather than assumed.

### Scope

Linear static, fully fixed supports, nodal loads. No pressure/thermal/modal/contact yet. Units fixed: mm, N, MPa.

## [0.1.1] - 2026-07-30

### Security

- **.geo command injection via the STEP path.** Gmsh's .geo language has a `System` command that executes shell commands, and the STEP path was interpolated into `Merge "…"` unescaped — a quote in the path was an injection vector. Paths containing quotes, backslashes or newlines are now rejected before any subprocess runs.
- **HTTP mode binds to loopback by default.** These tools execute code; `--hostname=0.0.0.0` is now an explicit choice, not the default.
