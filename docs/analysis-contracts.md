# Analysis contracts

`@casys/mcp-calculix` is a constrained STEP-to-observation service. It owns the
meshing, deck construction, native-process invocation, parsing, and closed
result schemas. A caller owns the source geometry and reviewed physical inputs.

## Capability surface

| Operation                        | Purpose                                                           | Structured result                |
| -------------------------------- | ----------------------------------------------------------------- | -------------------------------- |
| `calculix_mesh_preflight`        | Mesh and named-selection inspection before choosing solve physics | `mesh-selection-preflight` `1.0` |
| `calculix_solve_static`          | Linear elastic `*STATIC`                                          | `static-solve` `2.0`             |
| `calculix_solve_static_recorded` | Static solve with durable exact evidence                          | `static-solve-recorded` `2.0`    |
| `calculix_run_get`               | Read-only lookup by `run_id` or `request_id`                      | Recovery union `1.0`             |
| `calculix_solve_modal`           | Eigenfrequency `*FREQUENCY`                                       | `modal-solve` `1.0`              |
| `calculix_solve_buckling`        | Static preload followed by linear `*BUCKLE`                       | `buckle-solve` `1.0`             |
| `calculix_solve_creep`           | Constant-load `*VISCO` with a Norton law                          | `creep-solve` `1.0`              |
| `calculix_solve_coupled_thermal` | Steady-state `*COUPLED TEMPERATURE-DISPLACEMENT`                  | `coupled-thermal-solve` `1.0`    |

Every documented input object is closed. Unknown fields and invalid references
are refused with the precise input path rather than ignored. Every solve copies
the requested STEP file to a private per-call snapshot and computes SHA-256 from
the bytes Gmsh will consume. Ordinary solves can receive `expected_step_sha256`;
the recorded static path requires it and a caller-generated `request_id`.

## STEP, mesh, and selections

- `step_path` is absolute in the server filesystem. An HTTP server cannot read a
  file that exists only on the client; mount or stage the file where the server
  can see it.
- The generated Gmsh program publishes volume `1` as `PART`. The advertised
  contract is one part and one volume.
- `mesh_size_mm` is explicit. Choose it relative to the smallest relevant
  feature and perform a mesh-convergence study before relying on a result.
- `element_order` is `1` for C3D4 or `2` for C3D10 tetrahedra and defaults to
  `2`.
- Gmsh surface triangles are removed from its Abaqus export. The solver deck
  retains volume elements and node sets.

The preflight uses the same private snapshot and Gmsh lowering, without material
inputs, boundary conditions, deck generation, or CalculiX. It returns mesh-node
coordinate bounds in mm, mesh counts, and the node count for every requested
selection. Empty selections are closed diagnostics; the temporary snapshot and
mesh are removed at the end of the call and are not recorded evidence.

```json
{
  "step_path": "/inputs/bracket.step",
  "mesh_size_mm": 4,
  "selections": [
    {
      "name": "FIXED",
      "box": {
        "min": [-31, -21, -3.1],
        "max": [31, 21, -2.4]
      }
    }
  ]
}
```

Each boundary condition refers to a named, axis-aligned bounding-box selection.
The box becomes Gmsh `Surface In BoundingBox`, then a CalculiX NSET. This is
geometric selection, not persistent CAD topology naming:

- coordinates are in millimetres in the STEP coordinate system;
- `min` must be strictly below `max` on every axis, so a planar face needs a
  deliberate tolerance in its normal direction;
- names match `^[A-Za-z][A-Za-z0-9_]{0,60}$`;
- a broad box can select more than one surface;
- a selection with no nodes is a hard error naming that selection.

Use CAD geometry bounds and inspect `mesh.nodesPerSelection`; do not derive a
selection from an image.

## Units and physical conventions

| Quantity                          | Unit and behavior                                                        |
| --------------------------------- | ------------------------------------------------------------------------ |
| Geometry, mesh size, displacement | mm                                                                       |
| Force                             | N; each vector is a total force distributed evenly across selected nodes |
| Young's modulus and stress        | MPa                                                                      |
| Poisson's ratio                   | dimensionless, constrained to `(0, 0.5)`                                 |
| Modal density                     | kg/m³ input, converted to t/mm³ by `1e-12`; frequency output is Hz       |
| Time                              | s                                                                        |
| Temperature                       | °C; temperature differences also represent K differences                 |
| Conductivity                      | W/(m·K), numerically identical to mW/(mm·K)                              |
| Thermal expansion                 | 1/K                                                                      |
| Norton coefficient                | MPa^(-n) s^(-1), not Pa^(-n) s^(-1)                                      |

Material properties are explicit facts. The server never chooses them from a
material name. `fixed` constrains all translational degrees of freedom. Static,
buckling, and creep loads are total nodal-force vectors. A mechanically fixed
selection cannot also be mechanically loaded, including through a different
selection name that expands to the same mesh nodes. Thermal temperature
conditions remain independent of those mechanical degrees of freedom.

## Recorded static example

Compute the digest of the exact STEP bytes first. Reuse a `request_id` only for
an exact retry of the same canonical request.

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

The numerical values are examples for the repository fixture, not a material
database or a design recommendation.

## Analysis-specific notes

- Modal analysis requires density and returns ascending natural frequencies. It
  does not return mode shapes, participation factors, or effective modal mass.
- Buckling applies the supplied loads as a reference preload. Each returned
  `lambda` scales that load. This is a linear eigenvalue estimate, not nonlinear
  collapse or post-buckling behavior; an all-zero preload is refused.
- Creep holds the load for `duration_s` and returns the final converged
  increment. Its Norton coefficient uses MPa, and the server refuses premature
  completion beyond the documented scientific-print tolerance.
- Coupled thermal-mechanical analysis is steady state. At least one prescribed
  temperature is required. `reference_temperature_c` sets the zero-strain
  reference; specific heat and density are intentionally absent.

## Honest limits

- No assemblies, multiple solids, shells, beams, composite layups, multiple
  materials, or contact.
- No partial-DOF constraints, prescribed displacement, symmetry conditions,
  connectors, or joints.
- No pressure, traction, moment, gravity, body force, centrifugal load, or
  imported load field.
- Static is small-deformation linear elasticity. Buckling is linear eigenvalue
  buckling.
- Creep is one Norton law under constant load; there is no damage, rupture, or
  temperature-dependent material model.
- Coupled thermal analysis has prescribed nodal temperatures, conductivity, and
  isotropic expansion; there is no flux, convection, radiation, phase change, or
  transient response.
- Results expose bounded mesh counts and extrema, not complete fields, contours,
  convergence studies, or uncertainty estimates.
- Durable replay-checked resources are limited to recorded static solves.
- A solver success is not a requirement, fitness, safety, certification, or
  compliance conclusion.

## Resource budgets

The server enforces budgets before full in-memory admission and while streaming
native output. These are fleet-server limits, not Digital Thread product-proof
rules.

| Resource                       |      Limit |
| ------------------------------ | ---------: |
| STEP snapshot                  |     32 MiB |
| Named selections               |         32 |
| Mesh nodes                     |    250,000 |
| Mesh volume elements           |  1,000,000 |
| `mesh.inp` lines processed     |  1,000,000 |
| Node IDs per NSET              |    250,000 |
| Raw NSET entries               |  1,000,000 |
| Total NSET memberships         |  1,000,000 |
| Unique NSET names              |         34 |
| CalculiX deck                  |     65 MiB |
| Gmsh or CalculiX diagnostics   |      8 MiB |
| Executable version diagnostics |      4 KiB |
| Cleaned `mesh.inp`             |     64 MiB |
| `job.dat`                      |     64 MiB |
| Solve timeout                  | 120,000 ms |

Overruns return `resource_limit` or `output_limit` with the resource, bound,
observed value, and recovery guidance. Input and output are refused rather than
silently truncated.
