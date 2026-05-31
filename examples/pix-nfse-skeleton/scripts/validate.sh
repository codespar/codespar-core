#!/usr/bin/env bash
#
# Pix + NFS-e walking skeleton — verifies a runtime is reachable, then
# runs the vitest spec against it.
#
# The spec declares per-tool fixtures via the `mocks` field on
# `cs.create()`. That only works against a runtime started in test mode
# (`CODESPAR_TEST_MODE_ENABLED=true`); without it, `POST /sessions`
# rejects the mocks payload with HTTP 501 `mocks_not_permitted`.
#
# Runtime resolution (first match wins):
#   1. CODESPAR_BASE_URL is set       → use it, do NOT manage lifecycle
#                                       (caller's runtime must already be
#                                        in test mode — see NOTE below)
#   2. CODESPAR_RUNTIME_DIR is set    → boot `node server/start.mjs` from
#                                       there with test mode enabled
#   3. `docker` is available          → `docker run` of the published image
#                                       with CODESPAR_TEST_MODE_ENABLED=true
#                                       (default ghcr.io/codespar/codespar:latest;
#                                        must include session-mocks support —
#                                        commit 5830dc4 / PR #113 or later)
#   4. none of the above              → print instructions and exit non-zero

set -euo pipefail

SKELETON_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SKELETON_DIR"

RUNTIME_PORT="${CODESPAR_RUNTIME_PORT:-3000}"
HEALTH_URL="http://localhost:${RUNTIME_PORT}/health"
RUNTIME_IMAGE="${CODESPAR_RUNTIME_IMAGE:-ghcr.io/codespar/codespar:latest}"

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

# Mode 2: explicit clone path. Boot it from this directory so the bridge
# reads mcp-servers.json from cwd, with test mode enabled so the mocks
# the spec declares are honoured.
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

# Mode 3: published Docker image. Default path when nothing else is set.
# The container's cwd is set to this example directory so the bridge
# reads ./mcp-servers.json from a mounted volume, and the spawned MCP
# server paths in mcp-servers.json (./node_modules/@codespar/mcp-*)
# resolve against the example's installed node_modules.
# CODESPAR_TEST_MODE_ENABLED=true is passed in so the runtime honours
# the mocks the spec declares on cs.create().
if command -v docker >/dev/null 2>&1; then
  CONTAINER_NAME="codespar-skeleton-$$"
  RUNTIME_LOG="$SKELETON_DIR/.runtime.log"

  echo "validate.sh: starting runtime from $RUNTIME_IMAGE (port $RUNTIME_PORT)…"
  docker run -d --rm \
    --name "$CONTAINER_NAME" \
    -p "$RUNTIME_PORT:3000" \
    -v "$SKELETON_DIR:/example" \
    -w /example \
    -e CODESPAR_TEST_MODE_ENABLED=true \
    "$RUNTIME_IMAGE" \
    node /app/server/start.mjs \
    > "$RUNTIME_LOG" 2>&1 || {
      echo "validate.sh: docker run failed; check $RUNTIME_LOG" >&2
      exit 3
    }

  cleanup_docker() {
    docker stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
  }
  trap cleanup_docker EXIT INT TERM

  echo "validate.sh: polling $HEALTH_URL …"
  for i in $(seq 1 30); do
    if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
      echo "validate.sh: runtime up after ${i}s"
      break
    fi
    if [ "$i" = "30" ]; then
      echo "validate.sh: runtime did not become healthy in 30s" >&2
      echo "--- last 40 lines of container log ---" >&2
      docker logs "$CONTAINER_NAME" 2>&1 | tail -n 40 >&2 || true
      exit 3
    fi
    sleep 1
  done

  CODESPAR_BASE_URL="http://localhost:${RUNTIME_PORT}" \
  npx vitest run

  echo "validate.sh: ok"
  exit 0
fi

# Mode 4: nothing configured and no docker available — fail loud.
cat >&2 <<EOF
validate.sh: no runtime configured. Pick one:

  Option A (recommended) — install Docker and re-run this script. It
  will pull and run ghcr.io/codespar/codespar:latest automatically
  with CODESPAR_TEST_MODE_ENABLED=true wired in. The image must
  include the runtime's session-mocks support (commit 5830dc4 /
  PR #113 or later — on :latest as of the workflow re-publish):
    https://docs.docker.com/get-docker/
    npm run validate

  Option B — point at an already-running runtime (no boot, no kill).
  That runtime must have been started with
  CODESPAR_TEST_MODE_ENABLED=true:
    export CODESPAR_BASE_URL=http://localhost:3000
    npm run validate

  Option C — point at a local clone of codespar/codespar (this script
  boots and kills it for you, in test mode). The clone must include
  session-mocks support on main (commit 5830dc4 or later):
    git clone https://github.com/codespar/codespar.git /tmp/codespar
    (cd /tmp/codespar && git checkout main && npm install && npx turbo run build)
    export CODESPAR_RUNTIME_DIR=/tmp/codespar
    npm run validate

  Override the Docker image with CODESPAR_RUNTIME_IMAGE if you need a
  specific tag (default: ghcr.io/codespar/codespar:latest).
EOF
exit 2
