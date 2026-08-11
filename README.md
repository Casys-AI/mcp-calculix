# @casys/mcp-calculix

Stateless HTTP MCP server for deterministic finite-element analysis of STEP
files. It meshes with [Gmsh](https://gmsh.info), solves with
[CalculiX](http://www.calculix.de), and returns strict physical-results
contracts through its analysis tools plus recorded-static recovery tools.

```
STEP part → Gmsh tetrahedral mesh → CalculiX solve → physical results
```

## Tools

| Tool                             | Analysis                                                                           | Output                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `calculix_solve_static`          | Linear static (*STATIC)                                                            | max displacement (mm), max von Mises (MPa)               |
| `calculix_solve_static_recorded` | Linear static (*STATIC) with durable exact evidence                                | physical observations plus run/artifact ledger           |
| `calculix_run_get`               | Read-only recorded-run recovery                                                    | attested ledger by `run_id` or `request_id`              |
| `calculix_solve_modal`           | Eigenfrequency (*FREQUENCY)                                                        | natural frequencies (Hz)                                 |
| `calculix_solve_buckling`        | Linear buckling (*BUCKLE)                                                          | critical load factors                                    |
| `calculix_solve_creep`           | Viscoplastic creep (*VISCO + Norton law)                                           | end-state displacement (mm), von Mises (MPa)             |
| `calculix_solve_coupled_thermal` | Coupled temperature-displacement (*COUPLED TEMPERATURE-DISPLACEMENT, steady state) | max temperature (°C), displacement (mm), von Mises (MPa) |

All tools share the same face-selection convention (named axis-aligned bounding
boxes in mm) and STEP attestation (SHA-256 snapshot before any meshing starts).
Units: mm, N, MPa throughout.

## Recorded static runs and MCP resources

`calculix_solve_static` remains the frozen `static-solve` 2.0 contract.
`calculix_solve_static_recorded` is its explicit successor for a Digital Thread.
It requires both a caller-generated `request_id` and `expected_step_sha256`. The
server atomically persists a `dispatched` claim for that canonical request
before it copies the STEP file or starts Gmsh/CalculiX. A complete, synced claim
is built in a private candidate directory, then atomically published and its
parent synced; the final owner directory is never exposed without `claim.json`.
This claim elects one owner across concurrent calls and provider processes
sharing the volume. The private STEP snapshot must then match the declared
digest.

An exact completed retry returns the original run without another snapshot or
native process. Reusing the identity with different arguments fails closed. A
`dispatched` claim with no unique exact ledger has an unknown outcome and is
never redispatched. If the run directory became durable just before a crash, the
same process or a restart promotes the claim only after proving that one
matching ledger exists; duplicates or conflicts stop startup. A known
pre-completion failure becomes `quarantined`. `calculix_run_get` is a closed
state union (`completed`, `dispatched`, `quarantined`, `evicted`, or
`not_found`). A legacy owner directory left by the older mkdir-before-claim
window is reported separately as `outcome_unknown`, without fabricating a
`run_id`, and remains non-redispatchable. Recovery never needs message parsing.
Only `completed` includes a run.

Each recorded run exposes nine independently rehashed, closed MCP resources: the
exact `input.step` snapshot, `request.json`, `mesh.geo`, cleaned `mesh.inp`,
`gmsh.log`, `job.inp`, `ccx.log`, `job.dat`, and `result.json`. Their URIs have
the form `casys://calculix/runs/<run_id>/<name>`; `resources/read` never accepts
a filesystem path. The STEP is returned as an MCP `blob` with `model/step`; the
other artifacts are canonical UTF-8 `text` with exact JSON or `text/plain` media
types. Every read reopens the server-owned file and rechecks byte length and
SHA-256 against the 2.0 ledger. Startup and replay also parse `request.json` and
`result.json` as closed semantic contracts: physical quantities must be finite,
the normalized input identity must equal the run's exact STEP, requested
constraints must match the result, and every requested selection must have a
positive mesh count. Replay also reparses the exact `mesh.inp`, regenerates the
deterministic `job.inp` from that mesh and the resolved request, and reparses
`job.dat` to reproduce `result.json` metrics. `mesh.geo` resolves a stable
private relative `input.step`, never a random temporary path. Hash-coherent but
causally disconnected evidence fails closed before publication. Resource
publication uses the atomic batch API from exact dependency
`@casys/mcp-server@0.26.0`; a post-commit registration failure cannot roll back
the run, and `calculix_run_get` or an exact retry republishes it.

The recorded request materializes effective defaults (`element_order`,
`timeout_ms`). After the pure request wins its durable claim, that winner alone
observes the actual `gmsh` and `ccx` versions and seals them with the
server/method/lowering identity before execution. The provider records image
status as `unattested`; it never invents an OCI image digest. A completed retry
does not probe current binaries: the already sealed historical run wins even if
the host was upgraded. A new `request_id` observes and seals the current engine
identity.

Recorded runs live in `state/runs` by default, retain the newest 24, and are
loaded again at startup. Files are written with full-write loops, file data
sync, atomic rename and parent-directory sync. Configure
`CALCULIX_RUNS_DIRECTORY` and `CALCULIX_MAX_RECORDED_RUNS` for production. For a
container restart to retain evidence and idempotence, mount that configured
directory. Eviction first writes an `evicted` tombstone, unregisters all nine
dynamic resources, then removes the run directory. Tombstones are deliberately
retained beyond the run bound so an old `request_id` can never create a new run;
plan capacity for this monotonically growing request index. Each long-running
server has its own MCP resource registry: a run produced by another process
becomes visible in that process after restart or an explicit `calculix_run_get`
recovery call.

Completion staging is protected by an advisory inter-process writer lock. A
startup cleans hard-crash leftovers under `.staging` only after acquiring that
lock; if a live writer owns it, startup leaves every in-flight file untouched.

The request claim itself is cross-process safe, including two callers racing on
the same `request_id`. Retention and the live MCP resource registry are scoped
to one active writer process per runs volume. Do not run independent writers
with different request IDs against the same volume: they cannot unregister one
another's in-memory resources, and the `maxRuns` bound would then be enforced
only when a single process reloads the volume.

Within that single writer, completion and retention are serialized and checked
before the local acknowledgement is resolved. This avoids returning a run
already evicted by a concurrent local completion; it is not a distributed lease,
so the single-writer deployment constraint remains mandatory.

The recorded call uses the same physical inputs as the legacy static solve, but
the digest is mandatory:

```json
{
  "request_id": "fea-bracket-loadcase-0001",
  "step_path": "/exports/bracket.step",
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
standalone masthead or product shell. Both `calculix_solve_static` and its
recorded successor attach this resource. The viewer accepts their separate
closed 2.0 kinds and displays either the legacy audit path or the immutable STEP
resource URI without treating one as the other.

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

Fully fixed supports, nodal loads, first- or second-order tetrahedra. No
pressure, thermal-mechanical coupling, contact or requirement evaluation. Units
are mm, N and MPa.

## Docker

The Dockerfile at the repository root builds a self-contained image with Deno
2.9.4, Gmsh 4.12, and CalculiX 2.21 (Ubuntu 24.04 — `calculix-ccx` is absent
from Debian trixie). All JSR/npm dependencies are cached at build time; the
container starts without network access.

```bash
# Build (arm64 shown; omit --platform for the host default)
docker build --platform linux/arm64 -t mcp-calculix:local .

# Run — port 3015 in the parc, bound to loopback on the host
docker run -d --name mcp-calculix \
  -p 127.0.0.1:3015:3015 \
  -v exports:/exports \
  -v calculix-runs:/var/lib/mcp-calculix-runs \
  -e CALCULIX_RUNS_DIRECTORY=/var/lib/mcp-calculix-runs \
  mcp-calculix:local

# Smoke test (stateless 2026-07-28 protocol)
curl -s -X POST http://127.0.0.1:3015/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/list' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

The server binds `0.0.0.0:3015` inside the container so the published port is
reachable from the host. Override with `MCP_PORT` / `MCP_HOSTNAME` env vars.
STEP files and results land on the `/exports` volume; mount the same volume as
the `mcp-build123d` container to chain a CAD export directly into a FEA solve.

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
src/runs.ts                        # Atomic claims, exact ledgers, retention tombstones and resource reads
src/api/ccx.ts                     # Deck builders, parsers, ccx subprocess bridge
src/tools/solve.ts                 # Static solve pipeline
src/tools/modal.ts                 # Modal (*FREQUENCY) pipeline
src/tools/buckling.ts              # Buckling (*BUCKLE) two-step pipeline
src/tools/creep.ts                 # Creep (*VISCO + Norton) pipeline
src/tools/coupled_thermal.ts       # Coupled temperature-displacement (steady state)
src/ui/results-viewer/             # MCP App source and standalone build
src/ui/dist/results-viewer/        # Published self-contained viewer resource
tests/server_test.ts               # Stateless wire and resource contract
tests/runs_test.ts                 # Cross-process claims, recovery, eviction and exact resource lifecycle
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
