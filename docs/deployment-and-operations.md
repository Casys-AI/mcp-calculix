# Deployment and operations

## Published identities

The release workflow publishes the package to JSR with OIDC provenance and a
multi-architecture OCI image to GHCR. A GitHub release asset named
`release-identity.json` binds the version, tag, source commit, exact JSR
package, OCI index digest, and advertised platforms.

Tags such as `0.8.4` and `latest` are discovery channels. Deploy the digest from
the release identity:

```bash
RELEASE_IDENTITY_URL=https://github.com/Casys-AI/mcp-calculix/releases/download/v0.8.4/release-identity.json
curl -fsSLo release-identity.json "$RELEASE_IDENTITY_URL"
IMAGE_REF="$(jq -er '.image | select(test("^ghcr\\.io/casys-ai/mcp-calculix@sha256:[0-9a-f]{64}$"))' release-identity.json)"
docker pull "$IMAGE_REF"
```

The image entrypoint is `./docker-entrypoint.sh`; its default command is `http`.
It is published for `linux/amd64` and `linux/arm64`.

## HTTP transport

```bash
docker run --rm --name mcp-calculix \
  -p 127.0.0.1:3015:3015 \
  -v /absolute/path/to/step-files:/inputs:ro \
  -v calculix-runs:/var/lib/mcp-calculix-runs \
  -e CALCULIX_RUNS_DIRECTORY=/var/lib/mcp-calculix-runs \
  "$IMAGE_REF" http
```

The endpoint is `http://127.0.0.1:3015/mcp`. It implements the stateless
`2026-07-28` MCP transport: each request carries its protocol version and client
capabilities; there is no connection handshake or session ID.

```bash
curl -s -X POST http://127.0.0.1:3015/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: server/discover' \
  -d '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

The native entry point binds `127.0.0.1` by default. `--port` and `--hostname`
override it; `MCP_PORT` and `MCP_HOSTNAME` supply defaults when the CLI options
are absent.

## stdio transport

The native era-aware transport accepts classic `2025-06-18` initialization and
keeps JSON-RPC on stdout.

```bash
deno run --allow-all jsr:@casys/mcp-calculix@0.8.4/server --stdio
```

For the image, keep stdin open with `-i`, pass `stdio`, mount inputs read-only,
and mount a persistent run directory if recorded evidence is required.

## Native source run

Install Deno 2.9.6, Gmsh, and CalculiX:

```bash
apt install gmsh calculix-ccx     # Debian/Ubuntu
brew install deno gmsh calculix   # macOS/Homebrew
```

Then:

```bash
deno task serve
```

Missing `gmsh` or `ccx` produces an install-oriented error before an analysis
result can be returned. Ephemeral STEP and mesh directories are removed on a
best-effort basis after each call. Cleanup failure does not turn a preflight
into durable evidence; operators should monitor stale OS temporary directories.

## Recorded-run storage

```text
CALCULIX_RUNS_DIRECTORY=/persistent/path
CALCULIX_MAX_RECORDED_RUNS=24
```

Use one active writer per recorded-run directory or Docker volume. The claim
election is cross-process safe; retention and each live MCP resource registry
are single-writer responsibilities.

## Security posture

- Run with the smallest filesystem view possible. A read-only STEP input mount
  is preferred.
- Native HTTP binds to loopback. The Docker image binds inside its container so
  the explicit host mapping controls exposure.
- This repository supplies no authentication layer. Do not expose the MCP
  endpoint directly to an untrusted network.
- STEP paths containing quotes, backslashes, or newlines are refused before they
  can enter Gmsh input.
- File admission accepts anchored regular files only; directories, FIFOs,
  devices, and sockets are refused.
- Native calls have bounded time and diagnostics. On POSIX, timeout and output
  overruns terminate the isolated process group, including descendants that
  retain stdout or stderr.
- The server allows four concurrent calls and queues backpressure. Recorded
  completion and retention still require the one-writer rule.

See [SECURITY.md](../SECURITY.md) for private vulnerability reporting and
[Analysis contracts](analysis-contracts.md#resource-budgets) for enforced
budgets.
