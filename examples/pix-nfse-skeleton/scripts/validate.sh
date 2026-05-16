#!/usr/bin/env bash
#
# Pix + NFS-e walking skeleton — verifies a runtime is reachable, then
# runs the vitest spec against it.
#
# Runtime resolution (first match wins):
#   1. CODESPAR_BASE_URL is set       → use it, do NOT manage lifecycle
#   2. CODESPAR_RUNTIME_DIR is set    → boot `node server/start.mjs` from there
#   3. neither set                    → print instructions and exit non-zero
#
# Source of truth for demo mode: --demo in mcp-servers.json. The
# MCP_DEMO=true env below is informational parity only.

set -euo pipefail

SKELETON_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SKELETON_DIR"

RUNTIME_PORT="${CODESPAR_RUNTIME_PORT:-3000}"

# Mode 1: a runtime is already reachable. Just run the test.
if [ -n "${CODESPAR_BASE_URL:-}" ]; then
  echo "validate.sh: using running runtime at $CODESPAR_BASE_URL (lifecycle not managed)"
  MCP_DEMO=true npx vitest run
  echo "validate.sh: ok"
  exit 0
fi

# Mode 2: explicit clone path. Boot it from this directory so the
# bridge reads mcp-servers.json from cwd.
if [ -z "${CODESPAR_RUNTIME_DIR:-}" ]; then
  cat >&2 <<EOF
validate.sh: no runtime configured. Pick one:

  Option A — point at an already-running runtime (no boot, no kill):
    export CODESPAR_BASE_URL=http://localhost:3000
    npm run validate

  Option B — point at a local clone of codespar/codespar (this script
  boots and kills it for you):
    git clone https://github.com/codespar/codespar.git /tmp/codespar
    export CODESPAR_RUNTIME_DIR=/tmp/codespar
    npm run validate

  A future iteration will add a Docker option (\`docker run\` of a
  published \`ghcr.io/codespar/codespar:latest\` image) so neither a
  clone nor a local build is needed.
EOF
  exit 2
fi

RUNTIME_DIR="$CODESPAR_RUNTIME_DIR"
if [ ! -d "$RUNTIME_DIR" ]; then
  echo "validate.sh: CODESPAR_RUNTIME_DIR=$RUNTIME_DIR does not exist" >&2
  exit 2
fi
if [ ! -f "$RUNTIME_DIR/server/start.mjs" ]; then
  echo "validate.sh: $RUNTIME_DIR does not look like a codespar/codespar checkout (no server/start.mjs)" >&2
  exit 2
fi

HEALTH_URL="http://localhost:${RUNTIME_PORT}/health"
RUNTIME_LOG="$SKELETON_DIR/.runtime.log"

echo "validate.sh: starting runtime from $RUNTIME_DIR (port $RUNTIME_PORT)…"
(
  cd "$SKELETON_DIR"
  MCP_DEMO=true \
  PORT="$RUNTIME_PORT" \
  node "$RUNTIME_DIR/server/start.mjs" \
    > "$RUNTIME_LOG" 2>&1 &
  echo $! > "$SKELETON_DIR/.runtime.pid"
) || true

RUNTIME_PID="$(cat "$SKELETON_DIR/.runtime.pid" 2>/dev/null || echo "")"

cleanup() {
  if [ -n "${RUNTIME_PID:-}" ] && kill -0 "$RUNTIME_PID" 2>/dev/null; then
    kill "$RUNTIME_PID" 2>/dev/null || true
    wait "$RUNTIME_PID" 2>/dev/null || true
  fi
  rm -f "$SKELETON_DIR/.runtime.pid"
}
trap cleanup EXIT INT TERM

# Poll /health for up to 20 seconds.
echo "validate.sh: polling $HEALTH_URL …"
for i in $(seq 1 20); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    echo "validate.sh: runtime up after ${i}s"
    break
  fi
  if [ "$i" = "20" ]; then
    echo "validate.sh: runtime did not become healthy in 20s" >&2
    echo "--- last 40 lines of runtime log ---" >&2
    tail -n 40 "$RUNTIME_LOG" >&2 || true
    exit 3
  fi
  sleep 1
done

# Run the skeleton test against the running bridge.
MCP_DEMO=true \
CODESPAR_BASE_URL="http://localhost:${RUNTIME_PORT}" \
npx vitest run

echo "validate.sh: ok"
