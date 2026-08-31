# Recorded runs and viewer

The recorded static path adds durable identity and evidence around the same
bounded physical analysis. The MCP App is a read-only projection of exact
ordinary or recorded results; it is not another solver or a verdict surface.

## Recorded execution

`calculix_solve_static_recorded` freezes effective defaults, claims the
caller-supplied `request_id` before native execution, observes the actual Gmsh
and CalculiX versions, and seals the server, method, lowering, and engine
identity. The container image field stays literally `unattested`; the provider
does not invent an OCI digest.

An exact retry of a completed canonical request returns the original run without
starting a native process. Reusing the same request ID with different arguments
fails closed. Ambiguous dispatched outcomes are not blindly re-executed, and a
known pre-completion failure is quarantined.

`calculix_run_get` accepts exactly one lookup key:

```json
{ "request_id": "fea-bracket-loadcase-0001" }
```

or:

```json
{ "run_id": "r-00000000-0000-0000-0000-000000000000" }
```

Its recovery result stays one of `completed`, `dispatched`, `quarantined`,
`evicted`, `not_found`, or the legacy `outcome_unknown`. Those states are never
collapsed into an inferred success.

## Evidence resources

A completed run registers these exact resources:

| Name           | MIME type          | Meaning                                            |
| -------------- | ------------------ | -------------------------------------------------- |
| `input.step`   | `model/step`       | STEP snapshot consumed by Gmsh                     |
| `request.json` | `application/json` | Canonical effective request and execution identity |
| `mesh.geo`     | `text/plain`       | Exact Gmsh program using relative `input.step`     |
| `mesh.inp`     | `text/plain`       | Cleaned volume mesh consumed by the deck builder   |
| `gmsh.log`     | `text/plain`       | Gmsh diagnostics                                   |
| `job.inp`      | `text/plain`       | Code-generated CalculiX deck                       |
| `ccx.log`      | `text/plain`       | CalculiX diagnostics                               |
| `job.dat`      | `text/plain`       | Exact parsed CalculiX data output                  |
| `result.json`  | `application/json` | Normalized closed physical result                  |

Resource identities have the closed form:

```text
casys://calculix/runs/<run_id>/<resource-name>
```

Every read reopens the server-owned file and verifies its byte count and SHA-256
against the durable ledger. Recovery also reparses the request and result,
inspects `mesh.inp`, regenerates `job.inp`, and reparses `job.dat`. A collection
of hash-coherent but causally disconnected files is not published as a valid
run.

Runs live under `state/runs` by default and retain the newest `24`. Configure
`CALCULIX_RUNS_DIRECTORY` for persistent storage and
`CALCULIX_MAX_RECORDED_RUNS` with a positive integer. Evicted request IDs retain
tombstones, so they cannot silently create a second physical run. That index
grows monotonically and belongs in capacity planning.

Claim election is cross-process safe, but retention and the live MCP resource
registry are single-writer concerns. Use one active server writer per runs
directory. If another process completed a run, restart or invoke
`calculix_run_get` in the current process to republish its resources.

## MCP App contract

The server publishes:

- whole-view resource: `ui://mcp-calculix/results-viewer`;
- serialized App manifest: `ui://mcp-calculix/app-manifest`;
- App identity: `io.casys.mcp-calculix.results@0.8.5`;
- accepted read-only action: `viewer.session.apply`;
- recorded session schema:
  `io.casys.mcp-calculix.recorded-static-proof-session/1.0`.

The static solve, recorded static solve, and run lookup expose the view through
their metadata. The viewer parser accepts ordinary and recorded-static `2.0`
results. For a completed run lookup, it reads the exact `result.json`, verifies
URI, MIME type, byte count, and SHA-256 against the complete ledger, and only
then projects the observations. It never invokes a solve operation.

The default view is exactly one `calculix.static-result` semantic component. It
shows the result identity, maximum displacement, maximum von Mises stress, their
node or element IDs, and compact result provenance. It does not wrap mesh, STEP,
constraint, or detailed-extrema data into an application dashboard.

## TPS03 visual evidence

The README capture was produced from the actual versioned viewer bundle loaded
through the Casys Digital Thread read-only App host, then sent the exact TPS03
recorded session through `viewer.session.apply`.

That registered session names App version `0.8.4` and the bundle fingerprint
below. Release `0.8.5` changes the package/App identity and preserves the same
single-card surface. The documentation keeps the exact registered capture rather
than fabricating a successor session envelope.

| Item              | Exact identity                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| Session           | `mcp-app:db772cea8a8dee624bb36801a2b85af67eddd42657e956406b3c46b7678f1c4b`                       |
| Host anchor       | `calculix-isolated-result-json-b09ecd1782107093b505287f5800ac5e7f05cdaec5bbe845b4d19568bda64734` |
| Viewer bundle     | `sha256:6a2da9cba09795100a0d6d6f073e5693d666c8d22aee9b5816fcd273aa343845`                        |
| Bundle bytes      | `595508`                                                                                         |
| Result artifact   | `sha256:b09ecd1782107093b505287f5800ac5e7f05cdaec5bbe845b4d19568bda64734`                        |
| Project/thread    | `two-piece-tablet-stand-tps03 r135` / `Thread r17`                                               |
| Projection status | `available` with literal viewer label `Documentary`                                              |

The rendered observations are maximum displacement `0.00545 mm` at node `167`
and maximum von Mises stress `0.76019 MPa` at element `3764`. These values are
documentary evidence from that exact recorded result, not a requirement verdict.

The optimized PNG is
[`docs/assets/calculix-results-viewer-tps03.png`](assets/calculix-results-viewer-tps03.png),
1328 × 364 pixels. The image is documentation; the identities above and the
versioned bundle remain the machine-checkable join.

## Digital Thread boundary

This repository is the fleet `mcp-calculix` capability used for bounded analysis
and sensitivity work. The Digital Thread operation
`analyze.run-fea-sensitivity@1` may use that fleet provider.

The product operation `verify.run-fea-static-proof@3` is different. It runs Gmsh
and CalculiX in a digest-pinned local microVM, imports qualified lowering, and
combines Digital Thread-owned evidence with a separate SysON evaluation. It does
not call this MCP server and does not claim fleet-provider provenance. Therefore
a successful fleet solve is not a product static `@3` proof, and an isolated
`@3` result is not a recorded fleet run.

The recorded-session provenance union keeps those identities separate. Its
projection status remains literally `available`, `unresolved`, or `unavailable`.
The App requires its opaque host anchor to repeat the exact result artifact URI
and fingerprint. Available isolated results are rehashed as canonical JSON;
fleet results join the run and request identities plus canonical `result.json`
bytes to the recorded ledger.

The App recomputes `basis.sessionFingerprint` over the canonical subdocument
`{schemaVersion, kind, basis, anchor, provenance, projection}`. The `basis`
contains project, revision, subject, and thread; only the self-referential
fingerprint is omitted. Canonical JSON recursively sorts object keys, accepts
finite numbers, and refuses sparse or adorned arrays. Thread artifact
fingerprints keep their persisted-artifact meaning.
