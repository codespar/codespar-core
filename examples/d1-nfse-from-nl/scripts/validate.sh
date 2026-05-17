#!/usr/bin/env bash
#
# Service invoice from natural language — boots @copilotkit/aimock as a
# stand-in Anthropic API, verifies a runtime is reachable, then runs
# the vitest spec against it.
#
# Runtime resolution (first match wins):
#   1. CODESPAR_BASE_URL is set       → use it, do NOT manage its lifecycle.
#                                       Operator must already have configured
#                                       that runtime with
#                                       ANTHROPIC_BASE_URL=http://localhost:4010
#                                       (or the LLM calls will hit the real
#                                       Anthropic API).
#   2. CODESPAR_RUNTIME_DIR is set    → boot `node server/start.mjs` from there
#                                       with ANTHROPIC_BASE_URL pointed at the
#                                       local aimock.
#   3. `docker` is available          → `docker run` of the published image
#                                       (default ghcr.io/codespar/codespar:latest)
#                                       with --add-host=host.docker.internal:host-gateway
#                                       and ANTHROPIC_BASE_URL=http://host.docker.internal:4010
#   4. none of the above              → print instructions and exit non-zero
#
# Source of truth for demo mode: --demo in mcp-servers.json. The
# MCP_DEMO=true env below is informational parity only. ANTHROPIC_API_KEY
# is a placeholder — the SDK requires a value, aimock ignores it.

set -euo pipefail

SKELETON_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SKELETON_DIR"

RUNTIME_PORT="${CODESPAR_RUNTIME_PORT:-3000}"
HEALTH_URL="http://localhost:${RUNTIME_PORT}/health"
RUNTIME_IMAGE="${CODESPAR_RUNTIME_IMAGE:-ghcr.io/codespar/codespar:latest}"
AIMOCK_PORT="${AIMOCK_PORT:-4010}"
AIMOCK_FIXTURE="$SKELETON_DIR/fixtures/aimock-d1.json"
AIMOCK_LOG="$SKELETON_DIR/.aimock.log"
AIMOCK_PID_FILE="$SKELETON_DIR/.aimock.pid"

# ── aimock lifecycle ─────────────────────────────────────────────────
# Started BEFORE any runtime resolution path so docker / local-clone
# modes can point their ANTHROPIC_BASE_URL at it. The CODESPAR_BASE_URL
# path also starts aimock but warns the operator that the *already
# running* runtime must already be configured to talk to it.

start_aimock() {
  if [ ! -f "$AIMOCK_FIXTURE" ]; then
    echo "validate.sh: missing aimock fixture at $AIMOCK_FIXTURE" >&2
    exit 2
  fi
  echo "validate.sh: starting aimock on port $AIMOCK_PORT…"
  npx -p @copilotkit/aimock llmock --validate-on-load \
      -p "$AIMOCK_PORT" -f "$AIMOCK_FIXTURE" \
      > "$AIMOCK_LOG" 2>&1 &
  echo $! > "$AIMOCK_PID_FILE"

  for i in $(seq 1 20); do
    # aimock returns 404 at `/` when alive (no route registered there);
    # that's a positive liveness signal — the process is responding.
    # `-f` is omitted on purpose so 4xx is still a "got a response."
    code="$(curl -sS -o /dev/null -w "%{http_code}" "http://localhost:$AIMOCK_PORT" 2>/dev/null || echo "000")"
    if echo "$code" | grep -qE "^(2|3|4)"; then
      echo "validate.sh: aimock up after ${i}s (HTTP $code at root)"
      return 0
    fi
    if [ "$i" = "20" ]; then
      echo "validate.sh: aimock did not respond in 20s (last code: $code)" >&2
      echo "--- last 40 lines of aimock log ---" >&2
      tail -n 40 "$AIMOCK_LOG" >&2 || true
      stop_aimock
      exit 3
    fi
    sleep 1
  done
}

stop_aimock() {
  if [ -f "$AIMOCK_PID_FILE" ]; then
    local pid
    pid="$(cat "$AIMOCK_PID_FILE" 2>/dev/null || true)"
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
    rm -f "$AIMOCK_PID_FILE"
  fi
}

# Mode 1: a runtime is already reachable. Just start aimock and run
# the test. Operator owns the runtime lifecycle AND the runtime's
# ANTHROPIC_BASE_URL configuration; we warn loudly.
if [ -n "${CODESPAR_BASE_URL:-}" ]; then
  echo "validate.sh: using running runtime at $CODESPAR_BASE_URL (lifecycle not managed)"
  echo "validate.sh: NOTE — that runtime must already be configured with"
  echo "validate.sh:        ANTHROPIC_BASE_URL=http://localhost:$AIMOCK_PORT"
  echo "validate.sh:        or session.send() will reach the real Anthropic API."
  start_aimock
  trap stop_aimock EXIT INT TERM
  MCP_DEMO=true npx vitest run
  echo "validate.sh: ok"
  exit 0
fi

# Mode 2: explicit clone path. Boot the runtime from this directory
# (so the bridge reads `./mcp-servers.json`) AND export
# ANTHROPIC_BASE_URL so its Anthropic SDK calls aimock.
if [ -n "${CODESPAR_RUNTIME_DIR:-}" ]; then
  if [ ! -d "$CODESPAR_RUNTIME_DIR" ]; then
    echo "validate.sh: CODESPAR_RUNTIME_DIR=$CODESPAR_RUNTIME_DIR does not exist" >&2
    exit 2
  fi
  if [ ! -f "$CODESPAR_RUNTIME_DIR/server/start.mjs" ]; then
    echo "validate.sh: $CODESPAR_RUNTIME_DIR does not look like a codespar/codespar checkout (no server/start.mjs)" >&2
    exit 2
  fi

  start_aimock

  RUNTIME_LOG="$SKELETON_DIR/.runtime.log"
  echo "validate.sh: starting runtime from $CODESPAR_RUNTIME_DIR (port $RUNTIME_PORT)…"
  (
    cd "$SKELETON_DIR"
    MCP_DEMO=true \
    PORT="$RUNTIME_PORT" \
    ANTHROPIC_BASE_URL="http://localhost:$AIMOCK_PORT" \
    ANTHROPIC_API_KEY="placeholder" \
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
    stop_aimock
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

  MCP_DEMO=true \
  CODESPAR_BASE_URL="http://localhost:${RUNTIME_PORT}" \
  npx vitest run

  echo "validate.sh: ok"
  exit 0
fi

# Mode 3: published Docker image. The container's cwd is set to this
# example directory so the bridge reads `./mcp-servers.json` from a
# mounted volume. ANTHROPIC_BASE_URL points at the host's aimock via
# host.docker.internal (made resolvable via --add-host).
if command -v docker >/dev/null 2>&1; then
  start_aimock

  CONTAINER_NAME="codespar-d1-nfse-$$"
  RUNTIME_LOG="$SKELETON_DIR/.runtime.log"

  echo "validate.sh: starting runtime from $RUNTIME_IMAGE (port $RUNTIME_PORT)…"
  docker run -d --rm \
    --name "$CONTAINER_NAME" \
    --add-host=host.docker.internal:host-gateway \
    -p "$RUNTIME_PORT:3000" \
    -v "$SKELETON_DIR:/example" \
    -w /example \
    -e ANTHROPIC_BASE_URL="http://host.docker.internal:$AIMOCK_PORT" \
    -e ANTHROPIC_API_KEY="placeholder" \
    "$RUNTIME_IMAGE" \
    node /app/server/start.mjs \
    > "$RUNTIME_LOG" 2>&1 || {
      echo "validate.sh: docker run failed; check $RUNTIME_LOG" >&2
      stop_aimock
      exit 3
    }

  cleanup_docker() {
    docker stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
    stop_aimock
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

  MCP_DEMO=true \
  CODESPAR_BASE_URL="http://localhost:${RUNTIME_PORT}" \
  npx vitest run

  echo "validate.sh: ok"
  exit 0
fi

# Mode 4: nothing configured and no docker available — fail loud.
cat >&2 <<EOF
validate.sh: no runtime configured. Pick one:

  Option A (recommended) — install Docker and re-run this script. It
  will pull and run ghcr.io/codespar/codespar:latest automatically,
  wired to a local @copilotkit/aimock that stands in for the Anthropic
  Messages API. No real Anthropic key needed.
    https://docs.docker.com/get-docker/
    npm run validate

  Option B — point at an already-running runtime. The script does NOT
  manage that runtime's lifecycle. Make sure it is already configured
  with ANTHROPIC_BASE_URL=http://localhost:4010 so its session.send()
  call lands on the aimock this script boots, NOT the real Anthropic
  API:
    export CODESPAR_BASE_URL=http://localhost:3000
    # ensure that runtime was started with ANTHROPIC_BASE_URL=http://localhost:4010
    npm run validate

  Option C — point at a local clone of codespar/codespar (this script
  boots and kills it for you and wires ANTHROPIC_BASE_URL at the
  local aimock):
    git clone https://github.com/codespar/codespar.git /tmp/codespar
    (cd /tmp/codespar && npm install && npx turbo run build)
    export CODESPAR_RUNTIME_DIR=/tmp/codespar
    npm run validate

  Override the Docker image with CODESPAR_RUNTIME_IMAGE if you need a
  specific tag (default: ghcr.io/codespar/codespar:latest). Override
  the aimock port with AIMOCK_PORT (default: 4010).
EOF
exit 2
