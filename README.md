# @casys/mcp-calculix

MCP server for **finite element analysis** — [Gmsh](https://gmsh.info) meshing + [CalculiX](http://www.calculix.de) linear static solve on STEP files, driven by AI agents. **1 tool**.

```
part.step  (e.g. from @casys/mcp-build123d)
    │
  Gmsh      → tetrahedral mesh, faces designated by named bounding boxes
    │
  CalculiX  → linear static solve (fixed supports + nodal loads)
    │
  results   → max displacement (mm), max von Mises stress (MPa)
```

This closes the verification chain: a SysML mass budget checks against build123d's computed mass, and a SysML stress requirement checks against CalculiX's computed stress — each through `@casys/mcp-syson`'s constraint tools, with units.

## Requirements

```bash
apt install gmsh calculix-ccx     # Debian/Ubuntu
brew install gmsh calculix        # macOS
```

Both are spoken to as subprocesses over plain text files — no Python, no WASM, identical under Deno and Node. Missing binaries raise errors carrying these install commands.

## Quick Start

```json
{
  "mcpServers": {
    "calculix": {
      "command": "deno",
      "args": ["run", "--allow-all", "jsr:@casys/mcp-calculix/server"]
    }
  }
}
```

HTTP mode: `deno task serve` (port 3015).

## The tool: `calculix_solve_static`

```json
{
  "step_path": "/path/to/bracket.step",
  "mesh_size_mm": 3,
  "material": { "e_mpa": 70000, "nu": 0.33 },
  "selections": [
    { "name": "FIXED",  "box": { "min": [-31, -21, -3.1], "max": [31, 21, -2.4] } },
    { "name": "LOADED", "box": { "min": [-31, -21, 49.4], "max": [-24, 21, 50.1] } }
  ],
  "fixed": ["FIXED"],
  "loads": [ { "selection": "LOADED", "force_n": [0, 0, -500] } ]
}
```

```json
{
  "mesh": { "nodes": 9669, "elements": 5568, "nodesPerSelection": { "FIXED": 210, "LOADED": 87 } },
  "max_displacement_mm": 0.0428,
  "max_von_mises_mpa": 26.6,
  "max_von_mises_element": 5229
}
```

### Face designation — the design decision that matters

Faces are selected by **named axis-aligned bounding boxes in mm**: every surface of the part enclosed in a box joins that named set. This is explicit, deterministic, and scriptable by an agent that knows the part's bounding box (`build123d_execute` reports it). A selection whose box matches no surface is a **hard error naming the selection** — never an empty set silently carried into the solve.

### Everything physical is explicit

- `mesh_size_mm` — no default; pick relative to the smallest feature.
- `material.e_mpa`, `material.nu` — constants, never looked up from a material name.
- `loads[].force_n` — a **total** force vector in N, distributed evenly over the set's nodes.
- A selection both fixed and loaded is rejected (a fixed node ignores its load).

### Current scope, stated plainly

Linear static only. Fully fixed supports only (all translations). Nodal loads only — no pressure loads, no thermal, no modal, no contact yet. Element order 1 (C3D4) or 2 (C3D10, default, better stresses). Units are fixed: mm, N, MPa.

## Architecture

```
mod.ts                # Public API
server.ts             # MCP server (stdio + HTTP, port 3015)
src/
  api/
    gmsh.ts           # .geo generation, meshing, .inp cleanup + inspection
    ccx.ts            # deck generation, solve, .dat parsing (von Mises here)
  tools/
    solve.ts          # calculix_solve_static
  client.ts           # CalculixToolsClient
tests/
  fixtures/bracket.step  # the build123d spike bracket
  solve_test.ts          # 11 tests, full pipeline included
```

Two behaviours worth knowing, both learned the hard way and now handled:

- Gmsh's Abaqus export writes the surface triangles of every physical surface as CPS6 elements; CalculiX rejects them in a 3D analysis. They are stripped before the solve.
- CalculiX **silently skips** `*NODE PRINT` on an undefined node set. The all-nodes set is generated into the deck instead of trusted to exist.

## Development

```bash
deno task test     # 11 tests; need gmsh + ccx on PATH
deno check mod.ts server.ts
```

## License

MIT
