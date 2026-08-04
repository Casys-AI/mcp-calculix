# @casys/mcp-calculix

Stateless HTTP MCP server for deterministic finite-element analysis of STEP
files. It meshes with [Gmsh](https://gmsh.info), solves with
[CalculiX](http://www.calculix.de), and returns strict physical-results
contracts through five tools: `calculix_solve_static`,
`calculix_solve_modal`, `calculix_solve_buckling`, `calculix_solve_creep`,
and `calculix_solve_coupled_thermal`.

```
STEP part → Gmsh tetrahedral mesh → CalculiX solve → physical results
```

## Tools

| Tool | Analysis | Output |
|------|----------|--------|
| `calculix_solve_static` | Linear static (*STATIC) | max displacement (mm), max von Mises (MPa) |
| `calculix_solve_modal` | Eigenfrequency (*FREQUENCY) | natural frequencies (Hz) |
| `calculix_solve_buckling` | Linear buckling (*BUCKLE) | critical load factors |
| `calculix_solve_creep` | Viscoplastic creep (*VISCO + Norton law) | end-state displacement (mm), von Mises (MPa) |
| `calculix_solve_coupled_thermal` | Coupled temperature-displacement (*COUPLED TEMPERATURE-DISPLACEMENT, steady state) | max temperature (°C), displacement (mm), von Mises (MPa) |

All tools share the same face-selection convention (named axis-aligned bounding
boxes in mm) and STEP attestation (SHA-256 snapshot before any meshing starts).
Units: mm, N, MPa throughout.

## Requirements

```bash
apt install gmsh calculix-ccx     # Debian/Ubuntu
brew install gmsh calculix        # macOS
```

Gmsh and CalculiX run as local subprocesses over files. Missing binaries produce
an actionable install error.

## Run the server

Build the standalone results view, then serve the stateless HTTP endpoint:

```bash
deno task build:ui
deno task serve
```

The default endpoint is `http://127.0.0.1:3015/mcp`. It implements the
2026-07-28 stateless MCP transport: every request carries the protocol headers
and client metadata; it has no connection handshake or retained client state.

## `calculix_solve_static`

```json
{
  "step_path": "/path/to/bracket.step",
  "expected_step_sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "mesh_size_mm": 3,
  "material": { "e_mpa": 70000, "nu": 0.33 },
  "selections": [
    {
      "name": "FIXED",
      "box": { "min": [-31, -21, -3.1], "max": [31, 21, -2.4] }
    },
    {
      "name": "LOADED",
      "box": { "min": [-31, -21, 49.4], "max": [-24, 21, 50.1] }
    }
  ],
  "fixed": ["FIXED"],
  "loads": [{ "selection": "LOADED", "force_n": [0, 0, -500] }]
}
```

Before meshing, the tool copies `step_path` into a private per-call snapshot,
computes SHA-256 from that copy, and optionally compares it with
`expected_step_sha256`. A mismatch fails before Gmsh or CalculiX starts. The
tool publishes a closed `structuredContent` contract at schema version `2.0`:

```json
{
  "schemaVersion": "2.0",
  "kind": "static-solve",
  "inputArtifact": {
    "path": "/tmp/calculix-input-.../input.step",
    "sourcePath": "/path/to/bracket.step",
    "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "bytes": 4256
  },
  "mesh": {
    "nodes": 9669,
    "elements": 5568,
    "nodesPerSelection": { "FIXED": 210, "LOADED": 87 }
  },
  "constraints": {
    "fixedSelections": ["FIXED"],
    "loads": [{ "selection": "LOADED", "forceN": [0, 0, -500] }]
  },
  "metrics": {
    "maxDisplacement": {
      "value": 0.0428,
      "unit": "mm",
      "nodeId": 107,
      "vectorMm": [0, 0, -0.0428]
    },
    "maxVonMises": { "value": 26.6, "unit": "MPa", "elementId": 5229 }
  }
}
```

`inputArtifact.path` is the private snapshot actually passed to Gmsh; it is an
audit path and is removed when the tool call finishes. `sourcePath` is only the
location supplied by the caller. Identity and chaining must use `sha256`, not
either mutable path.

The tool links its result view at `ui://mcp-calculix/results-viewer`. The view
renders loading, constraints, mesh counts, extrema and the relevant physical
IDs. It intentionally reports observations without classifying them.

### Composable result components

The results MCP App publishes a component catalog under
`io.casys.mcp.view-components/v1`. Compose or an agent may select any subset and
arrange it with the bounded `stack`, `row`, or `grid` surface vocabulary:

| Component key                   | Data rendered                                                     |
| ------------------------------- | ----------------------------------------------------------------- |
| `calculix.solve-metrics`        | Maximum displacement and von Mises stress with their physical IDs |
| `calculix.mesh-summary`         | Node, element and named-selection counts                          |
| `calculix.constraints`          | Fixed selections and explicit load vectors                        |
| `calculix.displacement-details` | Maximum-displacement vector plus extrema node/element IDs         |

The standalone default is a two-column surface containing all four components.
Each block is a Preact component built from the shared `@casys/mcp-view/preact`
presentation kit; the kit handles narrow-container behavior. Compose selects the
exact component instances it needs, so embedded surfaces do not reproduce a
standalone masthead or product shell. `calculix_solve_static` is the sole result
producer attached to this resource, so every component receives the same strict
`static-solve` contract.

The viewer does not emit or consume domain Compose events: its result contains
extrema and physical IDs but no geometry-selection contract to synchronize. MCP
Apps input/result handlers remain registered before `connect()`. Surface
components and host-context listeners are disposed on route changes and host
teardown.

### Physical inputs

- `mesh_size_mm` has no implicit default; choose it for the smallest feature.
- `expected_step_sha256` is optional, but recommended when chaining from
  `build123d_export.files[].sha256`; the returned digest is always recomputed.
- `material.e_mpa` and `material.nu` are explicit constants, never a material
  lookup.
- `loads[].force_n` is a total force vector in N, distributed across the
  selection's nodes.
- Named, axis-aligned bounding boxes select faces deterministically. A box that
  matches no face is a named hard error.
- A selection cannot be both fixed and loaded.

### Scope

Fully fixed supports, nodal loads, first- or second-order tetrahedra.
No pressure, thermal-mechanical coupling, contact or requirement evaluation.
Units are mm, N and MPa.

## Development

```bash
deno task build:ui
deno task release:check
CALCULIX_RUN_NATIVE=1 deno task test
```

Native tests are opt-in so a checkout without Gmsh or CalculiX still validates
the wire contract and pure parsing stages.

## Package layout

```
server.ts                          # Stateless MCP application and HTTP entrypoint
src/results.ts                     # Closed result contracts (static v2, modal/buckle/creep/thermal v1)
src/api/ccx.ts                     # Deck builders, parsers, ccx subprocess bridge
src/tools/solve.ts                 # Static solve pipeline
src/tools/modal.ts                 # Modal (*FREQUENCY) pipeline
src/tools/buckling.ts              # Buckling (*BUCKLE) two-step pipeline
src/tools/creep.ts                 # Creep (*VISCO + Norton) pipeline
src/tools/coupled_thermal.ts       # Coupled temperature-displacement (steady state)
src/ui/results-viewer/             # MCP App source and standalone build
src/ui/dist/results-viewer/        # Published self-contained viewer resource
tests/server_test.ts               # Stateless wire and resource contract
tests/solve_test.ts                # Static: pure and opt-in native checks
tests/modal_buckle_test.ts         # Modal + buckling: pure and opt-in native checks
tests/creep_thermal_test.ts        # Creep + coupled thermal: pure and opt-in native checks
tests/fixtures/bracket.step        # Reference STEP for all native tests
tests/fixtures/bracket_modal.dat   # Real ccx 2.21 *FREQUENCY output (generated)
tests/fixtures/bracket_buckle.dat  # Real ccx 2.21 *BUCKLE output (generated)
tests/fixtures/bracket_creep.dat   # Real ccx 2.21 *VISCO output (generated, 7 increments)
tests/fixtures/bracket_thermal.dat # Real ccx 2.21 *COUPLED output (generated, steady state)
```

## License

MIT
