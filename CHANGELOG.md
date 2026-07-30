# Changelog

All notable changes to `@casys/mcp-calculix` will be documented in this file.

## [0.1.0] - 2026-07-30

Initial release.

### Added

- **`calculix_solve_static`** — one deterministic pipeline: STEP file → Gmsh tetrahedral mesh → CalculiX linear static solve → max displacement (mm) and max von Mises stress (MPa). Validated end to end against the build123d spike bracket (500 N → 26.6 MPa, holds against Al 6061 yield with 213 MPa margin).
- **Face designation by named bounding boxes** — every surface enclosed in a named box in mm becomes an Abaqus NSET. A box matching no surface is a hard error naming the selection.
- **Everything physical explicit** — mesh size, element order (C3D4/C3D10), material constants (`e_mpa`, `nu` — never looked up from a name), total nodal forces. A selection both fixed and loaded is rejected.
- **Subprocess bridges, plain text** — Gmsh and `ccx` over files, no Python, no WASM. Missing binaries raise errors carrying the install commands (`apt install gmsh calculix-ccx`).

### Hardened against, specifically

- Gmsh's Abaqus export includes CPS6 surface triangles that CalculiX rejects — stripped before the solve.
- CalculiX silently skips `*NODE PRINT` on an undefined set — the all-nodes NSET is generated into the deck rather than assumed.

### Scope

Linear static, fully fixed supports, nodal loads. No pressure/thermal/modal/contact yet. Units fixed: mm, N, MPa.
