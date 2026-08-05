# mcp-calculix — self-contained stateless HTTP MCP server for FEA solves
#
# Ubuntu 24.04 base: calculix-ccx was dropped from Debian trixie; Noble
# carries ccx 2.21 and gmsh 4.12 as maintained packages.
# Deno is copied as a static binary from the official release image.

FROM ubuntu:24.04

# --- Deno runtime ---
COPY --from=denoland/deno:bin-2.9.4 /deno /usr/local/bin/deno

# --- System solvers (gmsh + ccx) ---
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      calculix-ccx \
      gmsh \
 && rm -rf /var/lib/apt/lists/*

# /exports is the volume where callers deposit STEP files and collect results.
RUN mkdir -p /exports
VOLUME ["/exports"]

WORKDIR /app

# --- Dependency cache layer (deno.json + deno.lock only) ---
# Copied first so that source-only edits do not bust the module download layer.
COPY deno.json deno.lock ./

# Pre-fetch all external JSR/npm packages declared in deno.json using the
# pinned lock file. @casys/mcp-server pulls in hono, ajv, jose, otel, std/yaml
# transitively; the remaining specifiers cover std and test-only packages.
RUN deno cache --frozen \
      "jsr:@casys/mcp-server@0.24.1" \
      "npm:ajv@^8.17.1" \
      "npm:hono@^4" \
      "npm:hono@^4/cors" \
      "npm:jose@^6.0.0" \
      "npm:@opentelemetry/api@^1.9.0" \
      "jsr:@std/yaml@^1" \
      "jsr:@std/assert@^1" \
      "jsr:@std/path@^1.1.0"

# --- Application source ---
COPY . .

# Resolve and cache the full local module graph from the HTTP entrypoint so
# deno can start with --cached-only (no network at runtime).
RUN deno cache --frozen server.ts

EXPOSE 3015

# The server defaults to 127.0.0.1 (loopback). --hostname=0.0.0.0 binds all
# interfaces so the port is reachable outside the container.
# Override with MCP_PORT / MCP_HOSTNAME env vars if needed at deploy time.
CMD ["deno", "run", "--allow-all", "--cached-only", "--frozen", \
     "server.ts", "--port=3015", "--hostname=0.0.0.0"]
