# Changelog

All notable changes to `@casys/mcp-calculix` will be documented in this file.

## [Unreleased]

### Changed

- The results viewer now boots through `startPreactSurfaceApp` from
  `@casys/mcp-view-components@0.6.0` instead of a hand-written App lifecycle.
  Tool results and `viewer.session.apply` sessions are projected through the
  same `model.ts` parsers as before; the shared lifecycle owns view routing,
  host surface selection and the pre-connect session buffer.
- Removed the local `session-receiver.ts` buffer. `@casys/mcp-view@0.9.2`
  delivers sessions in order and holds those received before the App activates,
  which is the guarantee the shim provided.
- Status states render through the shared `StateMessage` primitive with the
  `calculix-viewer-state` class. Unresolved and unavailable recorded evidence
  are warning notices whose `code` carries the ledger status. A recorded session
  the strict parser refuses is a danger state titled `Session rejected` with
  code `session-rejected`; a tool result the projection cannot read is the
  shared `Result rejected` state; a viewer that cannot start shows
  `CalculiX viewer unavailable`. The loading state now carries the shared
  `Loading` title and `info` tone, and empty states the `Empty` title.
- Pins the split View checkout to the `mcp-server` revision that carries
  `@casys/mcp-view-components@0.6.0`.

## [0.8.5] - 2026-08-31

### Changed

- Carries the `0.8.4` viewer and documentation work into a publishable identity.
  The `v0.8.4` workflows stopped before any registry or image write because the
  repository-wide lint command traversed the checked-out split View source.
- Bounds linting to this repository's TypeScript sources, matching the existing
  formatting and type-check boundaries while leaving the pinned View checkout to
  its own repository gates.

## [0.8.4] - 2026-08-31

`v0.8.4` was tagged, but its official workflows stopped before publication. No
JSR package, GHCR tag, or GitHub release was created for this version.

### Added

- Ships and serves the exact MCP View App manifest for the CalculiX whole-view
  results resource, including `viewer.session.apply` and the recorded static
  proof session schema.
- Recorded viewer sessions now join their opaque host anchor to the exact
  provider result artifact. Available fleet and Digital Thread projections are
  also rehashed against their recorded result identity.

### Changed

- The default results viewer is one responsive MCP View v2 semantic result card
  containing only the result identity, two primary extrema readings, and compact
  provenance. Mesh, boundary-condition, STEP, and detailed-extrema objects are
  no longer rendered as a bundled dashboard catalog.
- The README now leads with a real TPS03 App capture and delegates analysis,
  evidence, deployment, and contributor detail to focused documentation pages.
- Release workflows now pin the split View source whose package identities match
  the locked viewer build (`mcp-view` `0.9.1`, contracts `0.1.0`, and components
  `0.2.0`).

## [0.8.3] - 2026-08-30

### Added

- Documented byte and cardinality budgets for STEP snapshots, Gmsh/CalculiX
  diagnostics, mesh files, decks, DAT results, named selections, and mesh
  node/element/NSET counts. Oversized inputs and outputs fail with stable
  `resource_limit` or `output_limit` errors that include `context` and
  `recovery`.

### Changed

- STEP snapshots, Gmsh, and CalculiX now enforce those budgets before a full
  in-memory read and while streaming subprocess stdout/stderr. Recorded static
  `timeout_ms` shares the same 120000 ms fleet cap as ordinary solves.
- Provider-produced mesh node, element, and NSET cardinalities are classified as
  `output_limit`; mesh lines, unique NSET names, and NSET work are bounded, and
  NSET membership is bounded both per set and cumulatively.
- File admission anchors a regular-file identity, copies through complete
  writes, and refuses special files. POSIX timeouts and diagnostic overruns
  terminate the full isolated solver process group.
- MCP transports map budget failures to `isError: true` with a JSON
  `{code, context, recovery}` body.

## [0.8.2] - 2026-08-28

### Changed

- Ordinary static, modal, buckling, creep, and coupled-thermal solves now cap
  each external Gmsh or CalculiX invocation at 120000 ms. Their schemas expose
  the `MAX_ORDINARY_SOLVE_TIMEOUT_MS` bound, and direct handlers return the
  typed `timeout_out_of_range` error at `timeout_ms` before snapshotting or
  native execution.
- The release image and tag workflows use official Deno 2.9.6 exactly. The
  Dockerfile pins the official multi-architecture `bin-2.9.6` OCI index for
  linux/amd64 and linux/arm64; CI installs `v2.9.6` rather than a moving major
  range.

## [0.8.1] - 2026-08-28

### Changed

- Every ordinary-solve input schema is recursively closed. Direct handler calls
  now reject unknown root and nested object fields before a STEP snapshot or
  native subprocess, with a stable input-error code and precise field path.
- Buckling requires at least one non-zero component across its reference loads;
  all-zero preload vectors have no critical-load-factor interpretation.
- Tag release workflows install and execute both Gmsh and CalculiX native test
  coverage. Docker publication additionally runs the static physical-observation
  smoke in the image built for release.

## [0.8.0] - 2026-08-28

### Added

- `calculix_mesh_preflight` performs the attested STEP snapshot and Gmsh mesh
  pass before a solve. Its closed `mesh-selection-preflight` `1.0` result
  reports mesh-node bounds in mm, mesh counts, nodes for each named selection,
  and structured `empty_selection` diagnostics. It has no material, load, deck,
  `ccx`, or durable-run path.

### Changed

- Gmsh mesh inspection no longer counts C3D10 continuation lines as separate
  elements.
- Mesh preflight reports semantic unique-node counts for repeated and `GENERATE`
  NSET blocks, refuses duplicate node IDs, and requires case-insensitively
  unique selection names.

## [0.7.2] - 2026-08-27

### Changed

- `server.ts --stdio` now uses the native, era-aware stdio transport. Legacy
  `2025-06-18` initialization, tool calls, and resource routing run in the
  server process; the stateless HTTP transport is unchanged.

## [0.7.1] - 2026-08-24

### Added

- `calculix_solve_static_recorded` now attaches the existing results-viewer MCP
  App metadata used by ordinary static solves. `calculix_run_get` does not,
  because its recovery result shape differs.

### Changed

- Ordinary static, modal, buckling, creep, and coupled-thermal solves validate
  shared physical inputs before the STEP snapshot, Gmsh, or CalculiX.
- Creep text summaries report the observed final increment time. A premature
  stop versus `duration_s` is rejected; `structuredContent` is unchanged.
- Mechanical fixed and load selections that share actual mesh node IDs are
  rejected even when their names differ. A thermal BC may still overlap a
  mechanically fixed set.

## [0.7.0] - 2026-08-11

### Added

- Recorded static solves with durable request identity, bounded run retention,
  exact artifact ledgers, MCP resources, and read-only recovery by request ID.
- Exact STEP, meshing, deck, solver-log, DAT, and normalized-result evidence,
  revalidated causally before commit and after restart.

### Changed

- Recorded execution now claims a request before native probing and never
  blindly redispatches an ambiguous, quarantined, completed, or evicted request.
- Runtime state under `state/` is explicitly excluded from source control.

## [0.6.0] - 2026-08-05

### Added

- `scripts/stdio-shim.ts`: stdio → stateless-HTTP adapter. Classic-SDK stdio
  clients (Docker MCP Toolkit, desktop hosts) get `initialize` answered locally
  from `server/discover`; everything else is forwarded in the 2026-07-28
  stateless envelope, which is the only revision the server accepts on the wire.
- `docker-entrypoint.sh`: the image now has two run modes — `http` (default,
  unchanged) and `stdio` (`docker run -i <image> stdio`).

## [0.5.0] - 2026-08-05

### Added

- **`calculix_solve_creep`** — viscoplastic (*VISCO) creep analysis with the
  Norton power law: STEP → Gmsh mesh → CalculiX creep solve → displacement and
  von Mises stress AT THE END of the specified creep duration.
  - `norton_a` and `norton_n` are required and explicit. `norton_a` must be in
    MPa^(-n) s^(-1); the tool description states the SI conversion (×10^(6n)).
  - `duration_s` and `initial_time_increment_s` are required. CalculiX may
    refine the increment if CETOL (1e-4 internal) is exceeded.
  - `parseDatLastIncrement` locates the final INCREMENT block before parsing —
    the global-max `parseDat` is wrong for creep under monotonically growing
    displacement, and would be wrong for relaxation scenarios.
  - `*SPECIFIC HEAT` and density are NOT required for this analysis type.
  - Validated on `bracket.step` (Al 6061-like, 8 mm linear tets, 500 N, 100 s,
    A=1e-10 MPa^(-3) s^(-1), n=3): 7 increments, last at t=100 s: max_disp ≈
    0.0129 mm, max_von_mises ≈ 8.64 MPa.

- **`calculix_solve_coupled_thermal`** — steady-state coupled
  temperature-displacement (*COUPLED TEMPERATURE-DISPLACEMENT, STEADY STATE)
  analysis: STEP → Gmsh mesh → CalculiX coupled solve → max temperature (°C),
  max displacement (mm), max von Mises stress (MPa).
  - Thermal BCs by named face selection: `{ selection, temperature_c }`. Each
    selection may carry only one temperature BC (duplicates rejected). A
    selection may be in both `fixed` and `thermal_bcs` — mechanical (DOF 1–3)
    and thermal (DOF 11) are independent in CalculiX.
  - Conductivity unit identity: 1 W/(m·K) = 1 mW/(mm·K) exactly (factors of 1000
    cancel); `conductivity_w_mk` is written as-is into `*CONDUCTIVITY`.
  - `*INITIAL CONDITIONS, TYPE=TEMPERATURE` is required by ccx and is injected
    automatically from `reference_temperature_c`.
  - `*SPECIFIC HEAT` is absent for steady state (intentional, not an omission;
    it becomes mandatory only for transient coupled analysis).
  - Element type: Gmsh emits C3D4/C3D10; ccx adds the thermal DOF automatically.
    C3D8T-style element names are unknown in ccx 2.21 — not used.
  - Validated on `bracket.step` (Al 6061, 8 mm linear tets, FIXED=20°C,
    LOADED=200°C, conductivity=167 W/(m·K), expansion=23.6e-6/K, ref=20°C):
    max_temp = 200°C, max_disp ≈ 0.1236 mm, max_von_mises ≈ 63.35 MPa.

- **`calculix_solve_modal`** — eigenfrequency (*FREQUENCY) analysis: STEP → Gmsh
  mesh → CalculiX free-vibration solve → natural frequencies in Hz.
  - `density_kg_m3` is required (no default); converted to t/mm³ by exact factor
    1e-12 (1 kg/m³ = 1e-12 t/mm³ in the mm/N/MPa/t/s unit system).
  - CalculiX requires uppercase-E scientific notation for density; the deck
    builder uses `toCcxFloat()`
    (`Number.prototype.toExponential(6).toUpperCase()`) to avoid the silent
    rejection of lowercase-e values.
  - `n_modes` in [1, 30] (default 6). Output: `frequenciesHz[]` ascending.
  - Validated on `bracket.step` (Al 6061, 4 mm quadratic mesh, fixed base): f₁ =
    1762.9 Hz, f₂ = 4732.5 Hz, f₃ = 9296.1 Hz.

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

- `solveDeck()` now delegates subprocess management to the private `runCcxRaw()`
  helper, eliminating code duplication across procedures. External interface is
  unchanged.

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

- The result viewer requires the attested input artifact and exposes its source,
  exact byte count and SHA-256. Results without provenance are rejected.

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
