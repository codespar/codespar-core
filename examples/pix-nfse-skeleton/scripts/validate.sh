#!/usr/bin/env bash
#
# Pix + NFS-e walking skeleton — verifies a runtime is reachable, then
# runs the vitest spec against it.
#
# The spec declares per-tool fixtures via the `mocks` field on
# `cs.create()`. That only works against a runtime started in test mode
# (CODESPAR_TEST_MODE_ENABLED=true); without it, `POST /sessions` rejects
# the mocks payload with HTTP 501 mocks_not_permitted.
#
# Runtime resolution (first match wins):
#   1. CODESPAR_BASE_URL is set       → use it, do NOT manage lifecycle
#                                       (the runtime there must already be
#                                        in test mode — see NOTE below)
#   2. CODESPAR_RUNTIME_DIR is set    → boot `node server/start.mjs` from
#                                       there with test mode enabled
#   3. none of the above              → print instructions and exit non-zero

set -euo pipefail

SKELETON_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SKELETON_DIR"

RUNTIME_PORT="${CODESPAR_RUNTIME_PORT:-3000}"
HEALTH_URL="http://localhost:${RUNTIME_PORT}/health"

# Mode 1: a runtime is already reachable. Just run the test.
#
# NOTE: the runtime at CODESPAR_BASE_URL must have been started with
# CODESPAR_TEST_MODE_ENABLED=true. Otherwise the mocks payload this spec
# sends on cs.create() is refused with HTTP 501 mocks_not_permitted and
# the test fails before the loop runs.
if [ -n "${CODESPAR_BASE_URL:-}" ]; then
  echo "validate.sh: using running runtime at $CODESPAR_BASE_URL (lifecycle not managed)"
  echo "validate.sh: NOTE — that runtime must have CODESPAR_TEST_MODE_ENABLED=true"
  npx vitest run
  echo "validate.sh: ok"
  exit 0
fi

# Mode 2: explicit clone path (canonical, recommended). Boot it from this
# directory so the bridge reads mcp-servers.json from cwd, with test mode
# enabled so the mocks the spec declares are honoured.
if [ -n "${CODESPAR_RUNTIME_DIR:-}" ]; then
  if [ ! -d "$CODESPAR_RUNTIME_DIR" ]; then
    echo "validate.sh: CODESPAR_RUNTIME_DIR=$CODESPAR_RUNTIME_DIR does not exist" >&2
    exit 2
  fi
  if [ ! -f "$CODESPAR_RUNTIME_DIR/server/start.mjs" ]; then
    echo "validate.sh: $CODESPAR_RUNTIME_DIR does not look like a codespar/codespar checkout (no server/start.mjs)" >&2
    exit 2
  fi

  RUNTIME_LOG="$SKELETON_DIR/.runtime.log"
  echo "validate.sh: starting runtime from $CODESPAR_RUNTIME_DIR (port $RUNTIME_PORT)…"
  (
    cd "$SKELETON_DIR"
    CODESPAR_TEST_MODE_ENABLED=true \
    PORT="$RUNTIME_PORT" \
    node "$CODESPAR_RUNTIME_DIR/server/start.mjs" \
      > "$RUNTIME_LOG" 2>&1 &
    echo $! > "$SKELETON_DIR/.runtime.pid"
  ) || true

  RUNTIME_PID="$(cat "$SKELETON_DIR/.runtime.pid" 2>/dev/null || echo "")"

  cleanup_clone() {
    if [ -n "${RUNTIME_PID:-}" ] && kill -0 "$RUNTIME_PID" 2>/dev/null; then
      kill "$RUNTIME_PID" 2>/dev/null || true
      wait "$RUNTIME_PID" 2>/dev/null || true
    fi
    rm -f "$SKELETON_DIR/.runtime.pid"
  }
  trap cleanup_clone EXIT INT TERM

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

  CODESPAR_BASE_URL="http://localhost:${RUNTIME_PORT}" \
  npx vitest run

  echo "validate.sh: ok"
  exit 0
fi

# Mode 3: nothing configured — fail loud with the supported setup paths.
cat >&2 <<EOF
validate.sh: no runtime configured. Pick one:

  Option B — point at an already-running runtime (no boot, no kill). The
  runtime must have been started with CODESPAR_TEST_MODE_ENABLED=true so
  the mocks this spec declares are honoured:
    export CODESPAR_BASE_URL=http://localhost:3000
    npm run validate

  Option C (recommended) — point at a local clone of codespar/codespar
  (this script boots and kills it for you, in test mode). The clone must
  include the session-mocks support on main (commit 5830dc4 or later):
    git clone https://github.com/codespar/codespar.git /tmp/codespar
    (cd /tmp/codespar && git checkout main && npm install && npx turbo run build)
    export CODESPAR_RUNTIME_DIR=/tmp/codespar
    export CODESPAR_TEST_MODE_ENABLED=true
    npm run validate
EOF
exit 2
