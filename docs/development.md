# Development and release gates

## Local checks

Deno 2.9.6 is the release toolchain.

```bash
deno task release:check
```

This gate checks formatting, types, lint, wire and contract behavior,
recorded-run recovery, parser fixtures, stdio lifecycle, viewer models, and the
versioned viewer bundle. Native Gmsh/CalculiX tests are opt-in:

```bash
CALCULIX_RUN_NATIVE=1 deno task test
```

The tag workflows install Gmsh and CalculiX, run that native coverage, and
execute a static observation smoke inside the built release image.

## Viewer build

Viewer source builds intentionally require explicit local split packages from
the matching `mcp-server` source revision:

```bash
export MCP_VIEW_LOCAL_ROOT=/absolute/path/to/mcp-server/packages/view
export MCP_VIEW_CONTRACTS_LOCAL_ROOT=/absolute/path/to/mcp-server/packages/view-contracts
export MCP_VIEW_COMPONENTS_LOCAL_ROOT=/absolute/path/to/mcp-server/packages/view-components
deno task build:ui
```

There is no fallback to a published monolithic package. The build validates
package identities and entry points before loading source. The release gate
rebuilds into a temporary path and compares the result byte-for-byte with
`src/ui/dist/results-viewer/index.html`, so shared-theme or generated-bundle
drift fails closed. Runtime consumers receive the versioned single-file viewer
and need none of these source packages.

## Source map

| Path                        | Responsibility                                             |
| --------------------------- | ---------------------------------------------------------- |
| `server.ts`                 | HTTP and stdio application; tool and resource registration |
| `src/api/budgets.ts`        | Byte/cardinality limits and bounded process capture        |
| `src/api/input-artifact.ts` | Attested STEP snapshots                                    |
| `src/api/gmsh.ts`           | Meshing and bounding-box node sets                         |
| `src/api/ccx.ts`            | Deterministic decks, native bridge, and parsers            |
| `src/results.ts`            | Closed result schemas                                      |
| `src/runs.ts`               | Claims, ledgers, resources, recovery, and retention        |
| `src/tools/`                | Analysis operation handlers                                |
| `src/viewer-session.ts`     | App manifest and exact recorded-session contract           |
| `src/ui/results-viewer/`    | Static-result MCP App source and build                     |
| `tests/`                    | Pure, wire, recovery, fixture, identity, and native tests  |

## Extending the capability

Keep physical inputs explicit, use closed versioned result schemas, reject
invalid references before subprocess execution, and back deck or parser changes
with a real CalculiX fixture plus opt-in native coverage.

Some additions require new authority rather than another JSON field:

- pressure, heat flux, or convection need stable surface-to-element-face
  lowering because the current path strips Gmsh surface elements;
- topology selections need a persistent upstream topology/group identity;
- recorded modal, buckling, creep, or thermal analyses need their own canonical
  request/result schemas, exact artifact sets, replay parsers, recovery states,
  and retention tests;
- assemblies, multiple materials, and contact need an explicit assembly,
  material, and interface model;
- complete fields need a bounded field contract, richer DAT/FRD parsing, output
  policy, evidence resources, and a deliberate viewer design.

## Release mechanism

A `v*` tag drives two official workflows:

- `.github/workflows/publish.yml` verifies the tag/version match, checks source
  and native behavior, then publishes the exact JSR version through OIDC if it
  does not already exist;
- `.github/workflows/docker.yml` repeats the source/native gates, builds and
  smokes the multi-architecture image, publishes GHCR tags, verifies the exact
  JSR provenance, and attaches `release-identity.json` to the GitHub release.

Both workflows pin the same exact split-view dependency commit. A successful
source check is not a release; publication is complete only when the JSR
provenance, GHCR index digest and platforms, GitHub identity asset, and fresh
consumption of those exact identities have been verified.
