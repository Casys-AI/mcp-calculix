# @casys/mcp-calculix

[![JSR](https://jsr.io/badges/@casys/mcp-calculix)](https://jsr.io/@casys/mcp-calculix)
[![Release checks](https://github.com/Casys-AI/mcp-calculix/actions/workflows/publish.yml/badge.svg)](https://github.com/Casys-AI/mcp-calculix/actions/workflows/publish.yml)
[![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A self-hosted MCP server for bounded finite-element analysis of STEP parts. It
uses [Gmsh](https://gmsh.info) to create a tetrahedral mesh, lowers explicit
physical inputs into a CalculiX deck, runs
[CalculiX](http://www.calculix.de), and returns closed, unit-bearing physical
results.

```text
STEP part -> private SHA-256 snapshot -> Gmsh C3D4/C3D10 mesh
          -> code-generated CalculiX deck -> parsed physical observations
```

Version `0.7.2` provides native, era-aware stdio and supports linear static,
modal, linear buckling, Norton-law creep, and steady-state coupled
temperature-displacement analyses. It also provides an identity-bound recorded
variant of the static solve with exact MCP evidence resources and read-only
recovery.

This is a constrained analysis service, not a generic CalculiX shell. Callers
provide STEP geometry and reviewed physical values; they cannot submit an
arbitrary `.inp` deck, command, executable, or solver flag. The server reports
observations, never a safety, compliance, or requirement verdict.

## Quick start

The published multi-architecture 0.7.2 release-code image is addressed by
`ghcr.io/casys-ai/mcp-calculix@sha256:94005f1d099356e5ec21ca35f289b16e29264d50ccee6aa0497f5427a7340cf0`.
It is available for `linux/amd64` and `linux/arm64`; its OCI version is
`0.7.2` and its revision is
`2d2f6d6172589d4891b37260b200fee6f1064efc`. Its entrypoint is
`./docker-entrypoint.sh` and its default command is `http`.

`ghcr.io/casys-ai/mcp-calculix:latest` is a mutable convenience tag, not an
immutable image identity. Use the digest for a versioned deployment.

```bash
docker pull ghcr.io/casys-ai/mcp-calculix@sha256:94005f1d099356e5ec21ca35f289b16e29264d50ccee6aa0497f5427a7340cf0
```

### HTTP over Docker

Run the stateless HTTP mode on loopback:

```bash
docker run --rm --name mcp-calculix \
  -p 127.0.0.1:3015:3015 \
  -v /absolute/path/to/step-files:/inputs:ro \
  -v calculix-runs:/var/lib/mcp-calculix-runs \
  -e CALCULIX_RUNS_DIRECTORY=/var/lib/mcp-calculix-runs \
  ghcr.io/casys-ai/mcp-calculix@sha256:94005f1d099356e5ec21ca35f289b16e29264d50ccee6aa0497f5427a7340cf0 http
```

The endpoint is `http://127.0.0.1:3015/mcp`. It implements the stateless
`2026-07-28` MCP transport: each request carries its protocol version and
client capabilities, and there is no connection handshake or session ID.

A discovery smoke test:

```bash
curl -s -X POST http://127.0.0.1:3015/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: server/discover' \
  -d '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

### Native stdio in 0.7.2

Version 0.7.2 starts the era-aware stdio transport directly. It accepts classic
`2025-06-18` initialization and keeps JSON-RPC on stdout.

Run the 0.7.2 JSR entrypoint:

```bash
deno run --allow-all jsr:@casys/mcp-calculix@0.7.2/server --stdio
```

Or run it from a source tree:

```bash
deno run --allow-all server.ts --stdio
```

To use native stdio from the published image, pass `stdio` to Docker and keep
stdin open with `-i`:

```json
{
  "mcpServers": {
    "calculix": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "-v",
        "/absolute/path/to/step-files:/inputs:ro",
        "-v",
        "calculix-runs:/var/lib/mcp-calculix-runs",
        "-e",
        "CALCULIX_RUNS_DIRECTORY=/var/lib/mcp-calculix-runs",
        "ghcr.io/casys-ai/mcp-calculix@sha256:94005f1d099356e5ec21ca35f289b16e29264d50ccee6aa0497f5427a7340cf0",
        "stdio"
      ]
    }
  }
}
```

Tool calls must use paths visible inside the container, such as
`/inputs/bracket.step`. Keep one live writer per recorded-run volume; do not point
multiple running server containers at the same `calculix-runs` volume.

### Native Deno run

Install Deno 2, Gmsh, and CalculiX first:

```bash
apt install gmsh calculix-ccx     # Debian/Ubuntu
brew install deno gmsh calculix   # macOS/Homebrew
```

Run the 0.7.2 JSR entrypoint over HTTP:

```bash
deno run --allow-all jsr:@casys/mcp-calculix@0.7.2/server --port=3015
```

From a source tree:

```bash
deno task build:ui
deno task serve
```

The native server binds `127.0.0.1` by default. `--port` and `--hostname`
configure that entry point; `MCP_PORT` and `MCP_HOSTNAME` supply the same values
when the corresponding CLI option is absent. Missing `gmsh` or `ccx` binaries
produce an install-oriented error before a result can be returned.

The JSR export also exposes the tool definitions, strict result schemas, deck
builders, parsers, and recorded-run store for Deno applications:

```bash
deno add jsr:@casys/mcp-calculix@0.7.2
```

## Tool surface

The server registers the following public capabilities:

| Tool | Analysis or action | Closed structured result |
| --- | --- | --- |
| `calculix_solve_static` | Linear elastic `*STATIC` | `static-solve` `2.0`: maximum displacement and von Mises stress |
| `calculix_solve_static_recorded` | Same static analysis with durable exact evidence | `static-solve-recorded` `2.0`: observations plus run/artifact ledger |
| `calculix_run_get` | Read-only lookup by one `run_id` or `request_id` | Recovery union `1.0`: `completed`, `dispatched`, `quarantined`, `evicted`, `not_found`, or legacy `outcome_unknown` |
| `calculix_solve_modal` | Eigenfrequency `*FREQUENCY` | `modal-solve` `1.0`: ascending natural frequencies in Hz |
| `calculix_solve_buckling` | Linear eigenvalue buckling: static preload then `*BUCKLE` | `buckle-solve` `1.0`: critical load factors |
| `calculix_solve_creep` | Constant-load `*VISCO` creep with a Norton law | `creep-solve` `1.0`: displacement and von Mises stress at the final converged increment |
| `calculix_solve_coupled_thermal` | Steady-state `*COUPLED TEMPERATURE-DISPLACEMENT` | `coupled-thermal-solve` `1.0`: maximum temperature, displacement, and von Mises stress |

Every solve copies the requested STEP file into a private per-call snapshot and
computes SHA-256 from the bytes that Gmsh will consume. Ordinary solves validate
shared physical inputs first — selection names and boxes, mesh size, element
order, timeout, material bounds, digest format, and declared fixed/load/BC
references — and reject those errors before the snapshot, Gmsh, or CalculiX.
Non-recorded solves accept `expected_step_sha256` optionally. The recorded
static solve requires it, together with a caller-generated `request_id`.

Only `calculix_solve_static_recorded` creates durable run evidence. Modal,
buckling, creep, coupled-thermal, and ordinary static results are closed MCP
results but do not create recorded-run resources in `0.7.2`.

## Geometry, selections, loads, and units

### STEP and Gmsh flow

- `step_path` is an absolute path in the server's filesystem namespace. An HTTP
  server cannot read a file that exists only on the MCP client's machine; mount
  or stage it where the server can see it.
- The generated Gmsh program publishes volume `1` as the `PART` physical
  volume. Treat `0.7.2` as a single-part, single-volume contract. Assemblies and
  multi-solid STEP models are not advertised inputs.
- `mesh_size_mm` has no default. Choose it relative to the smallest relevant
  feature and perform a mesh-convergence study before relying on a result.
- `element_order` is `1` for C3D4 linear tetrahedra or `2` for C3D10 quadratic
  tetrahedra. It defaults to `2`.
- Gmsh surface triangles are stripped from its Abaqus export; the CalculiX deck
  contains volume elements and node sets.

### Bounding-box face designation

Every boundary condition refers to a named selection:

```json
{
  "name": "FIXED",
  "box": {
    "min": [-31, -21, -3.1],
    "max": [31, 21, -2.4]
  }
}
```

The server emits Gmsh `Surface In BoundingBox` and turns every surface enclosed
by that axis-aligned box into a named node set. This is geometric selection, not
stable CAD topology naming:

- coordinates are in millimetres and refer to the STEP coordinate system;
- `min` must be strictly lower than `max` on all three axes, so a planar face
  needs a small amount of thickness in its normal direction;
- selection names must match `^[A-Za-z][A-Za-z0-9_]{0,60}$` because they become
  Abaqus/CalculiX NSET names;
- a broad box may intentionally capture more than one surface;
- a box that produces no nodes is a hard error naming the failed selection.

Get the part's bounding box from the CAD system that created the STEP file, add
a deliberate tolerance around the intended face, and inspect
`mesh.nodesPerSelection` in the result. Do not guess coordinates from an image.

### Physical conventions

| Quantity | Input/output unit and behavior |
| --- | --- |
| Geometry, mesh size, displacement | mm |
| Force | N; each `force_n` is a **total** vector distributed evenly across the selected nodes |
| Young's modulus, stress | MPa |
| Poisson's ratio | dimensionless and constrained to `(0, 0.5)` by deck construction |
| Modal density | kg/m³ input, converted exactly to t/mm³ by `1e-12`; frequencies are Hz |
| Time | s |
| Temperature | °C; temperature differences are also valid K differences for expansion |
| Conductivity | W/(m·K), written directly as mW/(mm·K), which is numerically identical |
| Thermal expansion | 1/K |
| Norton coefficient | MPa^(-n) s^(-1), **not** Pa^(-n) s^(-1) |

`material.e_mpa`, `material.nu`, density, conductivity, expansion, and Norton
parameters are caller-supplied physical facts. The server does not infer them
from a material name.

`fixed` means all three translational degrees of freedom are fixed. Static,
buckling, and creep loads are total nodal-force vectors. A mechanically fixed
selection cannot also be mechanically loaded, including when two different
names share actual mesh node IDs after NSET expansion (wrapped lists and
Abaqus `GENERATE`). In the coupled thermal tool, a selection may be both
mechanically fixed and assigned a temperature because those use independent
degrees of freedom.

## Examples

These examples use the repository's bracket coordinate system and assume the
file is visible to the server as `/inputs/bracket.step`. The numerical material
values are examples, not a material database or a design recommendation.

### Recorded linear static

Compute the SHA-256 of the exact STEP bytes first (`shasum -a 256` on macOS or
`sha256sum` on Linux), replace the example digest, and keep the same
`request_id` only when retrying the exact same canonical request.

```json
{
  "request_id": "fea-bracket-loadcase-0001",
  "step_path": "/inputs/bracket.step",
  "expected_step_sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "mesh_size_mm": 4,
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
  "loads": [
    { "selection": "LOADED", "force_n": [0, 0, -500] }
  ]
}
```

Call `calculix_solve_static_recorded` with that object. The ordinary
`calculix_solve_static` accepts the same physical fields without `request_id`;
its `expected_step_sha256` is optional.

### Modal

Modal analysis has no excitation load. Density is mandatory, and `n_modes`
defaults to `6` with an allowed range of `1..30`.

```json
{
  "step_path": "/inputs/bracket.step",
  "mesh_size_mm": 4,
  "material": { "e_mpa": 70000, "nu": 0.33 },
  "density_kg_m3": 2700,
  "selections": [
    {
      "name": "FIXED",
      "box": { "min": [-31, -21, -3.1], "max": [31, 21, -2.4] }
    }
  ],
  "fixed": ["FIXED"],
  "n_modes": 3
}
```

The result contains natural frequencies only. It does not expose mode-shape
fields or effective modal mass.

### Linear buckling

The loads define the reference static preload. For each returned factor
`lambda`, the corresponding critical load is `lambda * applied_load`; a first
factor below `1` means the reference load already exceeds the linear critical
load estimate.

```json
{
  "step_path": "/inputs/bracket.step",
  "mesh_size_mm": 4,
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
  "loads": [
    { "selection": "LOADED", "force_n": [0, 0, -500] }
  ],
  "n_modes": 2
}
```

This is a linear eigenvalue result, not nonlinear collapse or post-buckling
behavior.

### Norton-law creep

The load is applied and held for `duration_s`. The output is the state at the
last converged increment, not the maximum over the complete history. The text
summary reports the observed final increment time parsed from the displacement
and stress sections. A premature stop before `duration_s` (beyond CalculiX
scientific-print tolerance) is an error; `structuredContent` still carries the
requested duration and is otherwise unchanged.

```json
{
  "step_path": "/inputs/bracket.step",
  "mesh_size_mm": 8,
  "element_order": 1,
  "material": { "e_mpa": 70000, "nu": 0.33 },
  "norton_a": 1e-10,
  "norton_n": 3,
  "duration_s": 100,
  "initial_time_increment_s": 10,
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
  "loads": [
    { "selection": "LOADED", "force_n": [0, 0, -500] }
  ]
}
```

The fixture value `1e-10 MPa^(-3) s^(-1)` was chosen for a fast test and is not
a real-material recommendation. To express a Norton `A` coefficient given in
Pa^(-n) s^(-1) in the required MPa^(-n) s^(-1), multiply it by `10^(6n)`; for
`n = 3`, that factor is `10^18`.

### Steady-state coupled thermal-mechanical

At least one temperature boundary condition is required; two different
temperatures normally create the gradient of interest. Mechanical loads are
optional.

```json
{
  "step_path": "/inputs/bracket.step",
  "mesh_size_mm": 8,
  "element_order": 1,
  "material": { "e_mpa": 70000, "nu": 0.33 },
  "conductivity_w_mk": 167,
  "expansion_per_k": 0.0000236,
  "reference_temperature_c": 20,
  "selections": [
    {
      "name": "FIXED",
      "box": { "min": [-31, -21, -3.1], "max": [31, 21, -2.4] }
    },
    {
      "name": "HOT",
      "box": { "min": [-31, -21, 49.4], "max": [-24, 21, 50.1] }
    }
  ],
  "fixed": ["FIXED"],
  "thermal_bcs": [
    { "selection": "FIXED", "temperature_c": 20 },
    { "selection": "HOT", "temperature_c": 200 }
  ]
}
```

`reference_temperature_c` sets the zero-thermal-strain reference through
`*INITIAL CONDITIONS`. The solve is steady state, so specific heat and density
are intentionally absent. This tool does not perform a transient heat-up.

## Results, viewer, and provenance

### Ordinary results

Every solve returns a short text summary plus strict `structuredContent`.
Results include the exact STEP digest and byte count, mesh counts, named-set
node counts, the applied constraints, and the analysis-specific observations.
Extra or missing output fields are rejected by the server's closed schemas.

For a non-recorded solve, `inputArtifact.path` is the private snapshot that was
actually passed to Gmsh. It is removed when the call ends. `sourcePath` is only
the caller-supplied location. Use `inputArtifact.sha256`, not either mutable or
ephemeral path, as the input identity.

The server publishes the MCP App at `ui://mcp-calculix/results-viewer`.
`calculix_solve_static` and `calculix_solve_static_recorded` link it in their
tool metadata. The viewer parser accepts both ordinary and recorded-static
`2.0` results. `calculix_run_get` does not attach that viewer because its
recovery result shape differs. It displays constraints, mesh counts,
extrema, displacement vector, and the relevant node/element IDs without
classifying the observations. Its composable catalog is
`io.casys.mcp.view-components/v1`:

| Component | Content |
| --- | --- |
| `calculix.solve-metrics` | Maximum displacement and von Mises stress |
| `calculix.mesh-summary` | Node, element, and named-selection counts |
| `calculix.constraints` | Fixed selections and load vectors |
| `calculix.displacement-details` | Displacement vector and extrema node/element IDs |

### Recorded static runs

`calculix_solve_static_recorded` freezes effective defaults, claims the
caller-supplied `request_id` before native execution, observes the actual
`gmsh` and `ccx` versions, and seals the server/method/lowering/engine identity.
The container image identity remains explicitly `unattested`; the provider
does not invent an OCI digest.

An exact retry of a completed canonical request returns the original run
without starting Gmsh or CalculiX again. Reusing the same `request_id` with
different arguments fails closed. An ambiguous dispatched outcome is not
blindly re-executed. A known pre-completion failure is quarantined.

Each completed run registers exactly nine resources. Every read reopens the
server-owned file and verifies its byte count and SHA-256 against the durable
ledger:

| Resource name | MIME type | Meaning |
| --- | --- | --- |
| `input.step` | `model/step` blob | Exact STEP snapshot consumed |
| `request.json` | `application/json` text | Canonical effective request and execution identity |
| `mesh.geo` | `text/plain` | Exact Gmsh program, using the stable relative `input.step` |
| `mesh.inp` | `text/plain` | Cleaned volume mesh consumed by the deck builder |
| `gmsh.log` | `text/plain` | Gmsh diagnostics |
| `job.inp` | `text/plain` | Code-generated CalculiX deck |
| `ccx.log` | `text/plain` | CalculiX diagnostics |
| `job.dat` | `text/plain` | Exact CalculiX data output parsed by the server |
| `result.json` | `application/json` text | Normalized closed physical result |

Resource URIs are closed and have this shape:

```text
casys://calculix/runs/<run_id>/<resource-name>
```

Use `resources/read` with the issued URI; filesystem paths are never accepted
as resource identities. At startup and recovery the store also reparses the
request/result contracts, inspects `mesh.inp`, regenerates `job.inp`, and
reparses `job.dat` so a hash-coherent but causally disconnected bundle is not
published as a valid run.

Use `calculix_run_get` with exactly one lookup key:

```json
{ "request_id": "fea-bracket-loadcase-0001" }
```

or:

```json
{ "run_id": "r-00000000-0000-0000-0000-000000000000" }
```

Recorded runs live under `state/runs` by default and retain the newest `24`.
Set `CALCULIX_RUNS_DIRECTORY` to a persistent path and
`CALCULIX_MAX_RECORDED_RUNS` to a positive integer. Evicted request IDs retain
tombstones so they cannot silently create a second physical run; this request
index grows monotonically and must be included in capacity planning.

The claim election is cross-process safe, but retention and each live MCP
resource registry are single-writer concerns. Use one active server writer per
runs directory. If a different process completed a run, restart or call
`calculix_run_get` in the current process to republish its resources.

### Casys Digital Thread boundary

This repository is the fleet `mcp-calculix` capability used for bounded
analysis and sensitivity work. In `casys-digital-thread`,
`analyze.run-fea-sensitivity@1` may use this fleet provider.

The registered product operation `verify.run-fea-static-proof@3` is different:
it runs Gmsh and CalculiX in a digest-pinned local microVM, imports the qualified
core lowering, and then uses Digital Thread-owned evidence plus a separate
SysON evaluation. It does **not** call this MCP server and does not claim
`mcp-calculix` provenance. A successful fleet solve is therefore not a product
static `@3` proof, and an isolated `@3` result must not be relabelled as a fleet
MCP run.

## Honest limits in 0.7.2

- One advertised STEP part and one volume (`PART = {1}`), one isotropic
  material, and C3D4/C3D10 tetrahedra. No assemblies, shells, beams, composite
  layups, multiple materials, or contact.
- Fully fixed translational supports only. No partial-DOF constraints,
  prescribed mechanical displacement, symmetry condition, connector, or joint
  model.
- Total nodal forces only. No pressure, traction, moment, gravity/body force,
  centrifugal load, or imported load field.
- Static is small-deformation linear elasticity. Buckling is linear
  eigenvalue buckling, not nonlinear post-buckling or collapse.
- Modal returns frequencies only, not mode shapes, participation factors, or
  effective modal mass.
- Creep is a single Norton law under constant load and reports the final
  increment. It does not model prescribed-displacement stress relaxation,
  temperature-dependent creep parameters, damage, or rupture.
- Coupled thermal is steady state with prescribed nodal temperatures,
  conductivity, and isotropic expansion. No heat flux, volumetric heat source,
  convection, radiation, phase change, or transient response.
- Structured results expose mesh counts and extrema, not complete nodal or
  element fields, contours, convergence studies, or uncertainty estimates.
- Durable, replay-checked MCP resources exist only for recorded static solves.
- No solver success is converted into a requirement, fitness, safety,
  certification, or compliance conclusion.

These limits describe the public contract, not everything that CalculiX itself
can do.

## Extension map for contributors

Some extensions fit the current architecture more naturally than others. This
is a code map, not a release promise:

| Extension | What the implementation must add |
| --- | --- |
| Partial constraints or prescribed displacement | A versioned boundary-condition schema, deterministic `*BOUNDARY` lowering, result-contract review, and native fixtures |
| Pressure, heat flux, or convection | Stable surface-to-element-face lowering; the current pipeline strips Gmsh surface elements and retains node sets only, so this is not just a new JSON field |
| Recorded modal/buckling/creep/thermal runs | Analysis-specific canonical request/result schemas, exact artifacts, replay parsers, causal regeneration, recovery states, and retention tests; the static ledger is reusable infrastructure but not automatic provenance |
| Mode shapes or complete stress/temperature fields | A bounded field contract plus richer DAT/FRD parsing, output-size policy, resources, and viewer work |
| Topology-based selections | A stable upstream topology/group identity and deterministic lowering; AABBs alone cannot provide persistent CAD face identity after arbitrary geometry edits |
| Multiple solids, materials, or contact | A new assembly/material/interface model and substantial Gmsh/CalculiX lowering, validation, and evidence contracts |
| Transient thermal analysis | Explicit density, specific heat, time-grid/increment, initial-state, output-history, and convergence contracts |

When extending a tool, keep physical inputs explicit, add a closed versioned
result schema, fail before subprocess execution on invalid references, and back
the deck/parser change with a real CalculiX fixture plus an opt-in native test.

## Deployment and security notes

- The tools read caller-selected server-local files and launch `gmsh` and `ccx`.
  Run the service with the minimum filesystem visibility possible; a read-only
  input mount is preferable in Docker.
- HTTP binds to loopback by default in the native entry point. The Docker image
  binds inside its container so the explicit host port mapping controls
  exposure. No authentication layer is configured in this repository; do not
  expose the endpoint directly to an untrusted network.
- STEP paths containing quotes, backslashes, or newlines are rejected before
  they can be embedded in Gmsh input.
- External mesh and solve calls default to a `120000` ms timeout. Fine meshes,
  modal solves, and creep analyses may require an explicit larger timeout and
  appropriate host resource limits.
- The server allows four concurrent calls and queues backpressure. Recorded
  completion/retention still requires the one-writer-per-volume deployment
  rule described above.

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Development

```bash
deno task build:ui
deno task release:check
CALCULIX_RUN_NATIVE=1 deno task test
```

`deno task release:check` runs formatting, type checking, linting, wire/contract
tests, recorded-run recovery tests, parser fixtures, native stdio tests, and
viewer-model tests. Native end-to-end Gmsh/CalculiX tests are opt-in so a
checkout without solver binaries still verifies the pure and wire contracts.

Key files:

```text
server.ts                          HTTP and native stdio application, tool/resource registration
tests/stdio_test.ts                native stdio lifecycle and resource wire coverage
src/api/gmsh.ts                    STEP meshing and bounding-box node sets
src/api/ccx.ts                     deterministic decks, subprocess bridge, parsers
src/results.ts                     closed result schemas
src/runs.ts                        claims, ledgers, resources, recovery, retention
src/tools/solve.ts                 ordinary and recorded static tools
src/tools/modal.ts                 modal tool
src/tools/buckling.ts              linear buckling tool
src/tools/creep.ts                 Norton-law creep tool
src/tools/coupled_thermal.ts       steady-state coupled thermal tool
src/ui/results-viewer/             static results MCP App source
tests/                             pure, wire, recovery, fixture, and native tests
```

## Citation and license

Citation metadata is in [CITATION.cff](CITATION.cff). Licensed under the
[MIT License](LICENSE).
