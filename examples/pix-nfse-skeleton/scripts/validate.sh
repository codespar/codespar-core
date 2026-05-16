#!/usr/bin/env bash
#
# P3 walking skeleton — boots the OSS codespar runtime in the
# background, polls /health, runs vitest, and kills the runtime on
# exit. Mirrors the Validation block of codespar-web#326.
#
# Source of truth for demo mode: --demo in mcp-servers.json. The
# MCP_DEMO=true env below is informational parity only.

set -euo pipefail

SKELETON_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SKELETON_DIR"

# Resolve the OSS runtime checkout. CODESPAR_RUNTIME_DIR wins; otherwise
# fall back to the standard workspace layout sibling.
RUNTIME_DIR="${CODESPAR_RUNTIME_DIR:-$SKELETON_DIR/../../../codespar}"
if [ ! -d "$RUNTIME_DIR" ]; then
  echo "validate.sh: codespar runtime not found at $RUNTIME_DIR" >&2
  echo "  Set CODESPAR_RUNTIME_DIR or clone codespar/codespar as a sibling." >&2
  exit 2
fi

RUNTIME_PORT="${CODESPAR_RUNTIME_PORT:-3000}"
HEALTH_URL="http://localhost:${RUNTIME_PORT}/health"

# The example consumes @codespar/sdk via `file:../../packages/core`,
# which resolves to a copy of the package without its dist/ output. Run
# the SDK build once so the file: link points at a usable bundle.
if [ ! -f "$SKELETON_DIR/../../packages/core/dist/index.js" ]; then
  echo "validate.sh: building @codespar/sdk (first run only)…"
  (cd "$SKELETON_DIR/../.." && npm install --no-audit --no-fund && npm run build)
fi

# Boot the runtime in the background. The runtime reads
# ./mcp-servers.json from cwd, so start it from $SKELETON_DIR. The
# bridge then spawns each MCP child with --demo via the spec.command
# array (see mcp-servers.json).
RUNTIME_LOG="$SKELETON_DIR/.runtime.log"
echo "validate.sh: starting runtime from $RUNTIME_DIR (port $RUNTIME_PORT)…"
(
  cd "$SKELETON_DIR"
  MCP_DEMO=true \
  PORT="$RUNTIME_PORT" \
  node --experimental-strip-types "$RUNTIME_DIR/packages/core/src/server/index.ts" \
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
